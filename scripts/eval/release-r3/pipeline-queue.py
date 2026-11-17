"""顺序执行65条完整模拟流程，并在运行中测量宿主空间和本槽工作目录。"""
from pathlib import Path
import datetime as dt,hashlib,json,os,re,subprocess,sys,time
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
study=Path(sys.argv[1]).resolve();revision=sys.argv[2]
assert re.fullmatch(r'[a-zA-Z0-9-]+',revision)
out=study/('pipeline-queue-'+revision);out.mkdir()
env={**os.environ,'ANTHROPIC_API_KEY':'synthetic-local-key','ANTHROPIC_BASE_URL':'http://127.0.0.1:1','AXI_EVAL_IMAGE':'sha256:2c28b2b381ad0647f6a95afbd781e0d27e06a892fd40a164ac0dcb753fb92ba1','PYTHONDONTWRITEBYTECODE':'1'}
schedule=[(f'U{i:02}',p)for i in range(1,21)for p in ('v0','v1','claude')]+[('C7-L','v1'),('C7-O','v1')]+[('health',p)for p in ('v0','v1','claude')]
if len(sys.argv)>3:
    chosen=set(sys.argv[3:]);schedule=[s for s in schedule if s[0]in chosen]
def tree_bytes(roots):
    logical=allocated=0;seen=set()
    for root in roots:
        for base,dirs,names in os.walk(root,followlinks=False):
            dirs[:]=[d for d in dirs if not(Path(base)/d).is_symlink()]
            for name in names:
                p=Path(base)/name;st=p.lstat()
                if p.is_symlink()or not p.is_file()or(st.st_dev,st.st_ino)in seen:continue
                seen.add((st.st_dev,st.st_ino));logical+=st.st_size;allocated+=st.st_blocks*512
    return {'logicalBytes':logical,'allocatedBytes':allocated,'files':len(seen)}
def free():
    s=os.statvfs(study);return s.f_bavail*s.f_frsize
def measure(directory):
    targets=[];batch=directory/'batch.json'
    if batch.exists():
        b=json.loads(batch.read_text());targets.append(('axi-'+b['id']+'-'+b['runtimeId'],'axi.eval.batch',b['id']))
    for path in directory.glob('*-grade/**/sandbox.json'):
        d=json.loads(path.read_text());assert re.fullmatch(r'axi-r2-grade-[0-9a-f]{16}',d['name']);assert Path(d['case']).resolve().is_relative_to(directory)
        targets.append((d['name'],'axi.eval.grade.owner',d['owner']))
    rows=[]
    for name,key,wanted in targets:
        r=subprocess.run(['docker','inspect',name],capture_output=True,text=True,timeout=5)
        if r.returncode:continue
        info=json.loads(r.stdout)[0]
        if not info['State']['Running'] or info['State']['Paused']:continue
        assert info['Config']['Labels'].get(key)==wanted
        args=['docker','exec',name,'du','-sk','--exclude=node_modules','/task','/tmp']
        if key=='axi.eval.batch':args+=['/home/eval']
        r=subprocess.run(args,capture_output=True,text=True,timeout=5)
        rows.append({'container':name,'code':r.returncode,'stdout':r.stdout,'stderr':r.stderr,'allocatedBytes':sum(int(line.split()[0])*1024 for line in r.stdout.splitlines()if line.split()and line.split()[0].isdigit())})
    return rows
rows=[]
(out/'schedule.json').write_text(json.dumps(schedule,indent=2)+'\n')
for task,product in schedule:
    assert free()>=9*2**30,'低于保全底线，不能启动新模拟'
    root=study/'health'if task=='health'else study/('c7'if task.startswith('C7-')else'tasks')/task
    directory=root/('pipeline-'+product+'-'+revision)
    if task!='health':
        selected=json.loads((root/'grading-profile.json').read_text())['baselineQualification']
        audit=root/(selected.replace('qualification-','qualification-audit-',1)+'.json')
        if not audit.exists():print(json.dumps({'task':task,'phase':'waiting-material-qualification'}),flush=True)
        while not audit.exists():
            authorization=json.loads((study/'authorization.json').read_text())
            assert dt.datetime.now(dt.timezone.utc)<dt.datetime.fromisoformat(authorization['preparationDeadline']),'准备窗口已结束'
            time.sleep(10)
        assert json.loads(audit.read_text())['qualified']
        assert json.loads((root/selected/'results.json').read_text())['qualified']
    args=['bun',str(HERE/'pipeline-one.ts'),str(study),task,product,revision]
    label=task+'-'+product;started=time.time();before=free();low=before;peak=0;samples=0
    (out/(label+'.command.json')).write_text(json.dumps(args))
    with(out/(label+'.stdout')).open('xb')as stdout,(out/(label+'.stderr')).open('xb')as stderr,(out/(label+'.resources.jsonl')).open('x')as log:
        process=subprocess.Popen(args,env=env,stdout=stdout,stderr=stderr)
        while process.poll()is None:
            current=free();low=min(low,current);measurement=measure(directory)if directory.exists()else[];peak=max(peak,sum(r['allocatedBytes']for r in measurement));samples+=1
            log.write(json.dumps({'at':dt.datetime.now(dt.timezone.utc).isoformat(),'freeBytes':current,'containers':measurement})+'\n');log.flush()
            # 每条流程本身有执行/共享评分截止；不通过外部重试绕开它。
            time.sleep(2)
    row={'task':task,'product':product,'code':process.returncode,'seconds':time.time()-started,'freeBefore':before,'minimumObservedFree':low,'hostSpaceDeltaPeak':max(0,before-low),'workingAllocatedPeak':peak,'resourceSamples':samples}
    if process.returncode==0:
        result=json.loads((directory/'result.json').read_text());assert result['qualified']
        row.update(tree_bytes([directory,Path(result['traceDirectory']).parent]));row['result']=str((directory/'result.json').relative_to(study))
    rows.append(row);(out/'result.json').write_text(json.dumps({'qualified':False,'rows':rows},indent=2)+'\n');print(json.dumps(row),flush=True)
    if process.returncode:raise SystemExit(process.returncode)
(out/'result.json').write_text(json.dumps({'qualified':len(rows)==65,'complete':True,'mockOnly':True,'rows':rows},indent=2)+'\n')
