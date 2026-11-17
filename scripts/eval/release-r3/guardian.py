"""独立于CLI执行器的保全监督进程。不得启动或重试任何模型任务。"""
from pathlib import Path
import datetime as dt,json,os,subprocess,sys,time

def save(path,data):
    tmp=path.with_suffix('.tmp');raw=(json.dumps(data,ensure_ascii=False,indent=2)+'\n').encode()
    fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
    os.replace(tmp,path)

def command(args,seconds=2):
    try:
        r=subprocess.run(args,capture_output=True,text=True,timeout=seconds)
        return {'exitCode':r.returncode,'stdout':r.stdout[-2000:],'stderr':r.stderr[-2000:]}
    except Exception as e:return {'error':str(e)}

def identity(pid):return command(['ps','-p',str(pid),'-o','lstart=,command='])

def run(config):
    folder=Path(config['directory']);deadline=config['deadline']/1000
    if config.get('mockLowSpaceAt') is not None:assert config['mode']=='mock'
    mono_deadline=time.monotonic()+max(0,deadline-time.time())
    parent=identity(config['parentPid']);assert parent.get('exitCode')==0 and parent['stdout']==config['parentIdentity']
    inspected=command(['docker','inspect',config['container'],'--format','{{index .Config.Labels "axi.eval.batch"}}'])
    assert inspected.get('exitCode')==0 and inspected['stdout'].strip()==config['batch']
    save(folder/'guardian-ready.json',{'pid':os.getpid(),'parentPid':config['parentPid'],'deadline':config['deadline'],'batch':config['batch'],'ready':True})
    minimum=None;reason=None
    while True:
        if (folder/'guardian-stop-request.json').exists():
            request=json.loads((folder/'guardian-stop-request.json').read_text());assert request=={'action':'finish','batch':config['batch']}
            break
        try:
            disk=os.statvfs(config['study']);available=disk.f_bavail*disk.f_frsize
        except OSError:available=0
        if config.get('mockLowSpaceAt') is not None and time.time()*1000>=config['mockLowSpaceAt']:available=8*1024**3
        minimum=available if minimum is None else min(minimum,available)
        current=identity(config['parentPid'])
        if available<9*1024**3:reason='resource'
        elif current.get('exitCode')!=0 or current.get('stdout')!=config['parentIdentity']:reason='controller_lost'
        elif time.time()>=deadline or time.monotonic()>=mono_deadline:reason='deadline'
        if reason:break
        time.sleep(.25)
    stopped=None
    if reason:
        started=time.monotonic();save(folder/'guardian-trigger.json',{'reason':reason,'at':dt.datetime.now(dt.timezone.utc).isoformat(),'deadline':config['deadline']})
        # 即使代理控制通道失效，停止模型/工具也独立继续。
        request=json.dumps({'id':config['runId']}).encode()
        revoke=subprocess.Popen(['curl','--noproxy','*','--max-time','3','-fsS',config['endpoint']+'/control/revoke','-H','Authorization: Bearer '+config['admin'],'-H','content-type: application/json','--data-binary','@-'],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        revoke.stdin.write(request);revoke.stdin.close()
        unpause=command(['docker','unpause',config['container']],1)
        prefix=['docker','exec','-i','--user','0',config['container'],'setpriv','--reuid=1000','--regid=1000','--clear-groups','--bounding-set=-all','--inh-caps=-all','--ambient-caps=-all','--no-new-privs','bun','-e']
        def signal(sig):
            code="import{readdirSync,readFileSync}from'node:fs';let count=0;for(const p of readdirSync('/proc')){const n=Number(p);if(!n||n===1||n===process.pid)continue;try{if(/^Uid:\\s+1000\\s/m.test(readFileSync('/proc/'+p+'/status','utf8'))){process.kill(n,"+json.dumps(sig)+");count++}}catch{}}console.log(count)"
            return command(prefix+[code],1 if sig=='SIGINT' else 2)
        first=signal('SIGINT');time.sleep(max(0,1-(time.monotonic()-started)));last=signal('SIGKILL')
        stopped={'reason':reason,'processStoppedMs':(time.monotonic()-started)*1000,'unpause':unpause,'signal':first,'killed':last}
        try:revoke.wait(timeout=3)
        except subprocess.TimeoutExpired:revoke.kill();revoke.wait()
        stopped['revokeExitCode']=revoke.returncode
    result={'closed':True,'reason':reason,'deadline':config['deadline'],'minimumFreeBytes':minimum,'stop':stopped}
    save(folder/'guardian-result.json',result)

if __name__=='__main__':
    config=json.loads(Path(sys.argv[1]).read_text())
    try:run(config)
    except Exception as error:
        save(Path(config['directory'])/'guardian-failure.json',{'error':str(error)})
        raise
