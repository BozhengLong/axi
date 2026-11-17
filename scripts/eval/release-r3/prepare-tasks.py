"""复制已绑定的旧材料；只改公开预算文字，不移植任何真实能力分数。"""
from pathlib import Path
import hashlib,json,os,re,subprocess,sys,datetime as dt
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
sys.path.append(str(HERE.parent/'release-r2'))
from inputs import materialize,verify_initial,git_identity

def sha(p):
    with Path(p).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def read(p):return json.loads(Path(p).read_text())
def put(p,value):
    with Path(p).open('x') as f:json.dump(value,f,ensure_ascii=False,indent=2);f.write('\n')
def clone(source,target):
    target.parent.mkdir(parents=True,exist_ok=True)
    assert not target.exists()
    subprocess.run(['/bin/cp','-cRp',str(source),str(target)],check=True)
    assert source.stat().st_ino!=target.stat().st_ino

if __name__=='__main__':
    old,study=map(lambda p:Path(p).resolve(),sys.argv[1:3])
    assert read(study/'status.json')['phase']=='R2' and read(study/'authorization.json')['T1'] is None
    assert read(study/'engineering-admission.json')['qualified']
    revision=sys.argv[3] if len(sys.argv)>3 else '1';assert re.fullmatch(r'\d+',revision)
    out=study/('task-reuse-preparation-'+revision);out.mkdir();(out/'driver.py').write_bytes(Path(__file__).read_bytes())
    manifest=read(old/'release-manifest.json')
    # 在独立解释器内加载旧账本规则，避免同名controller模块相互替代。
    code="import sys,importlib.util,json;from pathlib import Path;sys.dont_write_bytecode=True;sys.path.insert(0,sys.argv[1]);s=importlib.util.spec_from_file_location('gateway',Path(sys.argv[1])/'controller-gateway.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m);state,h=m.read_state(sys.argv[2]);print(json.dumps({'state':state,'hash':h}))"
    state=json.loads(subprocess.check_output(['python3','-c',code,str(HERE.parent/'release-r2'),str(old/'formal-controller')]))
    put(out/'old-ledger.json',state)
    ledger=[json.loads(line) for line in (old/'formal-controller/controller-events.jsonl').read_text().splitlines()]
    assert state['state']['closure']['verdict']=='INCOMPLETE'
    claims=[row['payload']['id'] for row in ledger if row['action']=='claim']
    assert not any(re.match(r'T(?:0[2-9]|1\d|20)-',x) for x in claims)
    put(out/'exposure-ledger.json',{'oldLedger':str(old/'formal-controller/controller-events.jsonl'),'sha256':sha(old/'formal-controller/controller-events.jsonl'),'verifiedChain':state['hash'],'claims':claims,'T02ThroughT20Unclaimed':True})
    rows=[];mounts={}
    for entry in manifest['tasks'][1:]+manifest['c7Tasks']:
        old_id=entry['id'];new_id='U'+old_id[1:] if old_id.startswith('T') else old_id
        parent='tasks' if old_id.startswith('T') else 'c7'
        source=old/parent/old_id;target=study/parent/new_id
        if target.exists():
            reuse=read(target/'qualification-reuse.json')
            assert reuse['oldTask']==old_id and reuse['oldBinding']==entry['binding']
            verify_initial(target/'initial',read(target/'input-manifest.json'),reuse['gitIdentity'])
            for mount in read(target/'qualification-profile.json').get('dependencyMounts',[]):mounts[mount['source']]=mount
            rows.append({**{k:v for k,v in entry.items() if k not in ('binding','manifestHash','admitted','audit')},'id':new_id,'oldId':old_id,'sourceContract':reuse['sourceContract'],'audit':'qualification-audit-r3-1.json'})
            continue
        target.mkdir(parents=True)
        binding=read(old/entry['binding']['path']);assert sha(old/entry['binding']['path'])==entry['binding']['sha256']
        for item in binding['files']:assert sha(old/item['path'])==item['sha256'],item['path']
        initial=read(source/'input-manifest.json');verify_initial(source/'initial',initial,binding['gitIdentity'])
        materialize(source/'initial',target/'initial',initial)
        files=[]
        for p in sorted(source.iterdir()):
            if p.is_file() and (p.suffix=='.json' and not p.name.startswith('qualification-audit-') or p.suffix=='.md'):
                # 仅复制输入声明，不带开发运行结果。
                if p.name in ('input-manifest.json','qualification-profile.json','grading-profile.json','negative-controls.json','environment.json','references.json','reference-declarations.json') or p.name.endswith('-patch.json'):
                    clone(p,target/p.name);files.append({'path':p.name,'oldSha256':sha(p),'sha256':sha(target/p.name)})
        clone(source/'qualification-material',target/'qualification-material')
        allowed_briefs=('c7/brief.md',) if old_id=='C7-L' else ('brief.md',) if old_id=='C7-O' else ('eval/task.md','eval/brief.md')
        briefs=[e['path'] for e in initial['files'] if e['path'] in allowed_briefs]
        assert len(briefs)==1
        brief=briefs[0];before=(target/'initial'/brief).read_text()
        after,count=re.subn(r'30分钟[、/]50次实际生成请求','30分钟、不限制实际生成请求次数',before)
        # C7可能没有旧次数文字；不改其业务题面。
        assert count==1 if old_id.startswith('T') else count in (0,1)
        if count:
            (target/'initial'/brief).write_text(after)
            for file in initial['files']:
                if file['path']==brief:file['sha256']=sha(target/'initial'/brief)
            (target/'input-manifest.json').write_text(json.dumps(initial,ensure_ascii=False,indent=2)+'\n')
        business=lambda text:re.sub(r'30分钟(?:[、/]50次实际生成请求|、不限制实际生成请求次数)','<EXECUTION_POLICY>',text)
        assert business(before)==business(after)
        put(target/'business-contract.json',{'oldTask':old_id,'task':new_id,'path':brief,'oldSha256':hashlib.sha256(before.encode()).hexdigest(),'sha256':sha(target/'initial'/brief),'businessSha256':hashlib.sha256(business(after).encode()).hexdigest(),'budgetReplacementCount':count,'businessUnchanged':True})
        audit=read(source/entry['audit']);changes=[];proofs=[]
        for name in [audit['referenceQualification'],audit['negativeQualification']]:
            q=source/name;data=read(q/'results.json');assert data['qualified'] and data['facilityStable']
            for path,checksum in read(q/'facility.json').items():
                assert sha(q/'facility-source'/checksum)==checksum
                p=Path(path)
                if not p.exists() or sha(p)!=checksum:changes.append(str(p))
            proofs.append({'path':str(q/'results.json'),'sha256':sha(q/'results.json'),'cases':len(data['rows'])})
        # 旧五次证明仅在完整闭包核对后可降低到一次；准备阶段默认五次。
        reuse={'task':new_id,'oldTask':old_id,'oldStudy':str(old),'oldBinding':entry['binding'],'oldAudit':{'path':str(source/entry['audit']),'sha256':sha(source/entry['audit'])},'oldProofs':proofs,'changedDependencies':sorted(set(changes)),'repeats':5,'mode':'full-five','reason':'变动闭包或尚未完成同一性审计，默认重新五次','businessContract':sha(target/'business-contract.json'),'originalFiles':files,'gitIdentity':git_identity(target/'initial'),'sourceContract':str((target/'initial'/brief).relative_to(study)),'exposureApproved':False}
        put(target/'qualification-reuse.json',reuse)
        for mount in read(target/'qualification-profile.json').get('dependencyMounts',[]):mounts[mount['source']]=mount
        rows.append({**{k:v for k,v in entry.items() if k not in ('binding','manifestHash','admitted','audit')},'id':new_id,'oldId':old_id,'sourceContract':reuse['sourceContract'],'audit':'qualification-audit-r3-1.json'})
    # 深层依赖路径可能互相包含；克隆最上层即可保持链接及独立inode。
    sources=sorted(mounts,key=lambda x:(len(Path(x).parts),x));copied=[]
    for relative in sources:
        if any(Path(relative).is_relative_to(Path(done)) for done in copied):continue
        clone(old/relative,study/relative);copied.append(relative)
    put(out/'result.json',{'prepared':True,'tasks':rows,'dependencyClones':copied,'realModelStarts':0,'qualificationComplete':False,'at':dt.datetime.now(dt.timezone.utc).isoformat()})
    print(json.dumps({'prepared':len(rows),'dependencies':len(copied)}))
