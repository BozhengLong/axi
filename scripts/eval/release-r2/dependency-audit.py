"""在固定Linux镜像内核验只读依赖。摘要含全部文件、链接和权限。"""
from pathlib import Path
import json,subprocess,sys,datetime,hashlib
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
IMAGE='sha256:2c28b2b381ad0647f6a95afbd781e0d27e06a892fd40a164ac0dcb753fb92ba1'

def mounts(study,task=None):
    roots={}
    profiles=[study/'health/qualification-profile.json',*sorted((study/'tasks').glob('T*/qualification-profile.json')),*sorted((study/'c7').glob('C7-*/qualification-profile.json'))]
    for profile in profiles:
        p=json.loads(profile.read_text())
        if task and p['taskId']!=task:continue
        for m in p.get('dependencyMounts',[]):roots['bind:'+m['source']]={'kind':'bind','source':str(study/m['source'])}
        if p.get('dependencyVolume'):roots['volume:'+p['dependencyVolume']]={'kind':'volume','source':p['dependencyVolume']}
    return roots

def inspect(study,key,mount,destination):
    target='type='+mount['kind']+',src='+mount['source']+',dst=/dependencies,readonly'
    args=['docker','run','--rm','--network','none','--user','1000:1000','--read-only','--cap-drop=ALL','--security-opt','no-new-privileges','--cpus','1','--memory','512m','--pids-limit','64','--mount',target,'--mount','type=bind,src='+str(HERE/'dependency-tree.mjs')+',dst=/audit.mjs,readonly','--entrypoint','node',IMAGE,'/audit.mjs','/dependencies']
    process=subprocess.run(args,capture_output=True,text=True,timeout=300)
    if destination:
        destination.mkdir();(destination/'command.json').write_text(json.dumps(args));(destination/'stdout.json').write_text(process.stdout);(destination/'stderr.txt').write_text(process.stderr)
    assert process.returncode==0,process.stderr
    data=json.loads(process.stdout);return {'key':key,'sha256':data['sha256'],'entries':data['entries'],'bytes':data['bytes'],'mount':mount}

def verify(study,proof,task):
    expected={r['key']:r for r in proof['roots']};actual=[]
    for key,mount in mounts(study,task).items():
        assert key in expected and expected[key]['mount']==mount
        row=inspect(study,key,mount,None);assert row['sha256']==expected[key]['sha256'],'只读依赖改变: '+key;actual.append(row)
    return actual

if __name__=='__main__':
    study=Path(sys.argv[1]).resolve();out=study/sys.argv[2];assert out.is_relative_to(study);out.mkdir();(out/'dependency-tree.mjs').write_bytes((HERE/'dependency-tree.mjs').read_bytes());(out/'driver.py').write_bytes(Path(__file__).read_bytes())
    rows=[]
    for i,(key,mount)in enumerate(mounts(study).items()):
        rows.append(inspect(study,key,mount,out/str(i)));print('hashed',key,flush=True)
    result={'qualified':True,'image':IMAGE,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'roots':rows,'totalBytes':sum(r['bytes']for r in rows),'totalEntries':sum(r['entries']for r in rows)};(out/'result.json').write_text(json.dumps(result,indent=2)+'\n')
