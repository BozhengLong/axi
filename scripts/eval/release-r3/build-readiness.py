"""汇集R2已完成证据；资格未齐时拒绝生成冻结计划。"""
from pathlib import Path
from collections import Counter
import hashlib,json,re,subprocess,sys,datetime as dt
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent;REPO=HERE.parents[2]
study=Path(sys.argv[1]).resolve();pipeline_revision=sys.argv[2];recovery_revision=sys.argv[3]
read=lambda p:json.loads(Path(p).read_text())
def sha(p):
    with Path(p).open('rb')as f:return hashlib.file_digest(f,'sha256').hexdigest()
out=study/('readiness-'+pipeline_revision);out.mkdir()
def put(name,value):
    p=out/name
    with p.open('x')as f:json.dump(value,f,ensure_ascii=False,indent=2);f.write('\n')
    return str(p.relative_to(study))
def bound(path):
    p=Path(path);return {'path':str(p.relative_to(study)),'sha256':sha(p)}
def qualified(relative):
    d=read(study/relative);assert d['qualified'],relative;return relative
assert read(study/'status.json')['T1']is None
old=read(study/'task-reuse-preparation-2/result.json');exposure=read(study/'exposure-audit-1/result.json');assert exposure['qualified'] and len(exposure['rows'])==19
dependencies=read(study/'dependency-audit-1/old-copy-identity.json');assert dependencies['qualified']and len(dependencies['sameOldRoots'])==25
rows=[{'id':'U01','category':'R1','repository':'yargs/yargs-parser','upstreamCommit':'553c808cb0a8730980cacd23b8b8e3038ab7c61f','audit':'qualification-audit-r3-u01.json','userFiles':['notes/owner.md'],'userDirty':True,'productionDirty':False,'asyncBehavior':False,'asyncWitness':[],'sourceContract':'tasks/U01/initial/eval/task.md'}]+[r for r in old['tasks']if r['id'].startswith('U')]
assert [r['id']for r in rows]==[f'U{i:02}'for i in range(1,21)]
assert Counter(r['category']for r in rows)=={f'R{i}':5 for i in range(1,5)}
repositories=Counter(r['repository']for r in rows);assert len(repositories)>=8 and max(repositories.values())<=3
assert sum(r['userDirty']for r in rows)>=10 and sum(r['productionDirty']for r in rows)>=4 and sum(r['asyncBehavior']for r in rows)>=8
reuse=[]
for row in rows:
    task=study/'tasks'/row['id'];audit=read(task/row['audit']);assert audit['qualified']and audit['repeatRuleSatisfied']and audit['mode']=='current-five'
    if row['id']!='U01':assert read(task/'business-contract.json')['businessUnchanged']
    proof={'task':row['id'],'qualified':True,'oldMaterialsReused':row['id']!='U01','oldScoresReused':False,'oldFiveRepeatConclusionsAdopted':False,'currentQualification':bound(task/row['audit']),'mode':'full-current-five','reason':'保留旧材料及修订记录；本批资格入口和批次准入不同，未按分支证明所有旧执行闭包，统一用本批五次结果','exposureAudit':bound(study/'exposure-audit-1/result.json')if row['id']!='U01'else None}
    with(task/'qualification-reuse-final.json').open('x')as f:json.dump(proof,f,ensure_ascii=False,indent=2);f.write('\n')
    reuse.append(proof)
reuse_path=put('reuse.json',{'qualified':True,'rows':reuse,'dependencyIdentity':bound(study/'dependency-audit-1/old-copy-identity.json'),'counts':{'repositories':len(repositories),'userDirty':sum(r['userDirty']for r in rows),'productionDirty':sum(r['productionDirty']for r in rows),'async':sum(r['asyncBehavior']for r in rows)},'businessUnchangedFor19':True,'newTask':'U01'})
# R1运行代码不得在R2悄悄改变。新增准备入口单列，不替代原产品/代理/评分实现。
r1='b7d1d110c30d902511f97550ad60c53679a9f7f1'
paths=subprocess.check_output(['git','ls-tree','-r','--name-only',r1,'--','src','scripts/eval'],cwd=REPO,text=True).splitlines()
unchanged=[]
recovery_gate=read(study/'recovery-gate-qualification-1/result.json');assert recovery_gate['qualified']and recovery_gate['checks']==125
freeze_audit=read(study/'freeze-serialization-qualification-1/audit.json');assert freeze_audit['qualified']and freeze_audit['actualMockCli']==45 and freeze_audit['sourceStable']
changed_scope={'scripts/eval/release-r3/controller.py','scripts/eval/release-r3/formal-grade.py','scripts/eval/release-r3/core.ts'};changed=[]
for name in paths:
    if Path(name).suffix not in ('.py','.ts','.mjs','.cjs'):continue
    original=subprocess.check_output(['git','show',r1+':'+name],cwd=REPO)
    if (REPO/name).read_bytes()!=original:
        expected=freeze_audit['coreSha256']if name.endswith('/core.ts')else recovery_gate['sourceHashes'].get(str(REPO/name))
        assert name in changed_scope and sha(REPO/name)==expected,'R1后发生未声明执行/评分改动: '+name
        changed.append({'path':name,'beforeSha256':hashlib.sha256(original).hexdigest(),'sha256':sha(REPO/name)})
    else:unchanged.append({'path':name,'sha256':hashlib.sha256(original).hexdigest()})
assert {r['path']for r in changed}==changed_scope
qualified('recovery-facility-requalification-1/result.json')
impact_path=put('r1-impact.json',{'qualified':True,'r1Commit':r1,'allOtherExistingExecutionAndGradingSourcesUnchanged':True,'files':unchanged,'changed':changed,'scope':'恢复评分准入、健康完成期限与监督/收尾序列。当前45条重验截止、资源、崩溃、写入失败及完整截止归因；新65条覆盖全部正常流程，两恢复链覆盖实际恢复。候选、代理、适配、监督脚本和评分语义核心未改。','gateQualification':bound(study/'recovery-gate-qualification-1/result.json'),'controllerRequalification':bound(study/'recovery-facility-requalification-1/result.json'),'freezeRequalification':bound(study/'freeze-serialization-qualification-1/audit.json'),'adoptedR1Proof':bound(study/'engineering-admission.json')})
engineering=read(study/'engineering-admission.json');assert engineering['qualified'];replaced=[]
for evidence in engineering['runtimeEvidence'].values():
    for i,entry in enumerate(evidence):
        path=entry['path'];match=re.match(r'(guard-qualification-|orphan-qualification-|deadline-cli-|controller-qualification-|mutant-qualification-)(\d+)(/.*)',path)
        if not match:continue
        prefix,number,suffix=match.groups();number=int(number);offsets={'guard-qualification-':(310,314,500),'orphan-qualification-':(310,319,500),'deadline-cli-':(1,5,100),'controller-qualification-':(204,208,220),'mutant-qualification-':(202,206,220)};low,high,start=offsets[prefix]
        if low<=number<=high:
            replacement=bound(study/(prefix+str(start+number-low)+suffix));replaced.append({'before':entry,'after':replacement});evidence[i]=replacement
engineering.update(r2Impact=bound(study/impact_path),r2EvidenceReplacements=replaced,r2CheckedAt=dt.datetime.now(dt.timezone.utc).isoformat());engineering_path=put('engineering.json',engineering)
controller_rows=[]
for i in range(220,225):
    p=study/f'controller-qualification-{i}/result.json';d=read(p);assert d['qualified']and d['checks']==46;controller_rows.append(bound(p))
recovery_path=qualified('recovery-chains-'+recovery_revision+'/result.json');recovery=read(study/recovery_path);assert recovery['nativeIntegrationQualified']and recovery['recoveryChains']==2
controller_path=put('controller.json',{'qualified':True,'nativeIntegrationQualified':True,'stateMachineRepeats':5,'checksPerRepeat':46,'proofs':controller_rows,'nativeRecovery':bound(study/recovery_path),'pipelineAudit':bound(study/qualified('pipeline-audit-'+pipeline_revision+'/result.json'))})
plan={'tasks':rows,'c7Tasks':[r for r in old['tasks']if r['id'].startswith('C7-')],'healthTask':{'id':'health'},'pipelineRevision':pipeline_revision,'c7RegressionProof':qualified('c7-regression-qualification-r3v1/results.json'),'proofs':{'engineering':engineering_path,'controller':controller_path,'capture':qualified('capture-qualification-r3v1/results.json'),'dependencies':qualified('dependency-audit-1/result.json'),'resourcePolicy':qualified('resource-policy-'+pipeline_revision+'/result.json'),'evidenceAudit':qualified('pipeline-audit-'+pipeline_revision+'/result.json'),'reuse':reuse_path},'at':dt.datetime.now(dt.timezone.utc).isoformat()}
put('plan.json',plan);print(json.dumps({'qualified':True,'plan':str(out/'plan.json'),'tasks':20,'repositories':len(repositories)}))
