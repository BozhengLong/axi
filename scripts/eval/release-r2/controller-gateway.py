"""执行层与持久发布账本之间的证据入口。正式准入只读取完整冻结文件。"""
from pathlib import Path
import datetime as dt
import fcntl
import importlib.util
import controller as controller_module
import hashlib
import json
import os
import re
import subprocess
import sys
sys.dont_write_bytecode=True
# 与controller.py共同冻结，资格账本不能替代正式账本。
from controller import Ledger,Refused,digest,next_slot,slots,decisive_failure


def require(condition,message):
    if not condition:raise Refused(message)


def sha(path):
    h=hashlib.sha256()
    with Path(path).open('rb')as f:
        while data:=f.read(1024*1024):h.update(data)
    return h.hexdigest()


def read_state(directory):
    directory=Path(directory);path=directory/'controller-events.jsonl'
    require(path.exists(),'账本尚未初始化')
    with(directory/'controller.lock').open('a+b')as lock:
        fcntl.flock(lock,fcntl.LOCK_SH);raw=path.read_bytes()
        require(raw.endswith(b'\n'),'账本末行不完整')
        previous=None;last_at=None;state=None
        for i,line in enumerate(raw.splitlines()):
            row=json.loads(line);checksum=row.pop('hash')
            require(digest(row)==checksum and row['previous']==previous and row['sequence']==i,'账本链或顺序损坏')
            require(last_at is None or row['at']>=last_at,'账本时钟倒退')
            previous=checksum;last_at=row['at'];state=row['state']
        require(state is not None,'空账本');return state,previous


def bound_file(study,entry):
    name=entry['path'];relative=Path(name)
    require(not relative.is_absolute()and '..'not in relative.parts and str(relative)==name,'证据路径不是规范相对路径')
    path=study/relative
    for parent in [path,*path.parents]:
        if parent==study:break
        require(parent.is_relative_to(study)and not parent.is_symlink(),'证据路径含链接或越界')
    require(path.is_file()and sha(path)==entry['sha256'],'绑定证据缺失或改变: '+name)
    return path


def verify_sources(study,manifest):
    index=json.loads(bound_file(study,manifest['facilityIndex']).read_text())
    require(digest(index)==manifest['facilityHash'],'设施总身份不符')
    require(index['files'],'设施清单为空')
    for entry in index['files']:
        path=Path(entry['path']);require(path.is_file()and not path.is_symlink()and sha(path)==entry['sha256'],'设施源码改变: '+str(path))
    return index


def verify_admission(study,manifest):
    require(manifest['schema']==1 and manifest['qualificationComplete']is True,'完整准备未通过')
    require(manifest['commit']==manifest['remoteCommit'],'冻结提交未推送')
    auth=json.loads((study/'authorization.json').read_text());require(manifest['T0']==auth['T0'],'T0身份不符')
    require(manifest['identities']['candidate']=='dbe7e145d205c21b580d8c2ee2dcf58c408380d8','候选不符')
    require(manifest['identities']['sourceHash']=='14be06a50a8163d4461c1d6e6a498ede412b13dc927f80fa4cf323446a552855','产品源码不符')
    require(manifest['identities']['model']=='claude-opus-5-5'and manifest['identities']['claude']=='2.1.322','冻结模型或参照不符')
    required={'engineering','taskPackage','c7','controller','pipeline','capture','dependencies','resourcePolicy','evidenceAudit'}
    require(set(manifest['proofs'])==required,'准备证明种类不完整')
    proofs={key:json.loads(bound_file(study,value).read_text())for key,value in manifest['proofs'].items()}
    require(all(v.get('qualified')is True for v in proofs.values()),'准备存在未通过项')
    require(proofs['pipeline']['taskCases']==60 and proofs['pipeline']['c7Cases']==2,'62条CLI资格不完整')
    require(proofs['taskPackage']['referenceCases']==300 and proofs['taskPackage']['counterfactualCases']==100,'20题参考资格不完整')
    require(proofs['controller']['nativeIntegrationQualified']is True,'控制器实际执行接线未取得资格')
    require(proofs['engineering']['candidate']==manifest['identities']['candidate'],'工程证明不是当前候选')
    verify_sources(study,manifest)
    require([t['id']for t in manifest['tasks']]==[f'T{i:02}'for i in range(1,21)],'20题顺序错误')
    for task in manifest['tasks']+manifest['c7Tasks']:
        binding=json.loads(bound_file(study,task['binding']).read_text())
        require(digest(binding)==task['manifestHash']and binding['admitted']is True,'题目绑定未准入')
        for entry in binding['files']:bound_file(study,entry)
    return proofs


def resources(study,manifest):
    policy=json.loads(bound_file(study,manifest['proofs']['resourcePolicy']).read_text())
    stat=os.statvfs(study);available=stat.f_bavail*stat.f_frsize
    require(available>=policy['minimumFreeBytes'],'宿主磁盘低于冻结阈值')
    result=subprocess.run(['docker','info','--format','{{json .}}'],capture_output=True,text=True,timeout=15)
    require(result.returncode==0,'Docker不可用');info=json.loads(result.stdout)
    require(info['MemTotal']>=policy['minimumDockerMemoryBytes']and info['NCPU']>=policy['minimumDockerCpus'],'Docker资源低于冻结阈值')
    return {'freeBytes':available,'dockerMemory':info['MemTotal'],'dockerCpus':info['NCPU']}


def apply(study,action,payload,mode='real'):
    study=Path(study).resolve();require(mode in ('real','mock'),'未知运行模式')
    if mode=='mock':
        require(os.environ.get('ANTHROPIC_API_KEY')=='synthetic-local-key'and os.environ.get('ANTHROPIC_BASE_URL')=='http://127.0.0.1:1','模拟控制器不能使用真实上游')
        label=payload.pop('ledgerLabel');require(re.fullmatch(r'[a-zA-Z0-9-]+',label),'模拟账本标签不合法');directory=study/'controller-integration'/label
    else:directory=study/'formal-controller'
    if action=='status':
        state,checksum=read_state(directory);return {'state':state,'ledgerHash':checksum}
    if action=='initialize':
        require(mode=='real','模拟初始化由独立资格驱动构造')
        auth=json.loads((study/'authorization.json').read_text());manifest=json.loads((study/'release-manifest.json').read_text());verify_admission(study,manifest)
        ledger=Ledger(directory)
        state=ledger.apply('initialize',{'authorization':auth,'identities':manifest['identities']});return {'state':state}
    state,checksum=read_state(directory)
    ledger=Ledger(directory)
    if mode=='real':
        manifest=json.loads((study/'release-manifest.json').read_text());verify_admission(study,manifest)
        require(state['identities']==manifest['identities'],'账本身份不符')
    else:
        require(state['identities'].get('mockOnly')is True,'模拟入口不能使用正式账本');manifest=state['manifest']
    if action=='freeze':
        require(mode=='real','模拟冻结由资格驱动构造');state=ledger.apply('freeze',manifest);return {'state':state}
    if action=='begin':
        require(mode=='real','模拟T1由资格驱动构造');state=ledger.apply('begin',{});return {'state':state}
    if action=='claim':
        slot=next_slot(state)
        if mode=='real':resources(study,manifest)
        request={'id':slot['id'],'identities':state['identities'],'manifestHash':digest(state['manifest']),'facilityHash':state['repair']['facilityHash']if state['repair']and state['repair'].get('completedAt')else state['manifest']['facilityHash'],'requestLimit':slot['limit']}
        state=ledger.apply('claim',request);return {'claim':state['claims'][slot['id']],'ledgerDirectory':str(directory)}
    if action=='launched':
        claim=state['claims'][payload['id']];require(claim['slot']['product']==payload['product']and claim['slot']['task']==payload['task'],'执行槽题目或产品不符')
        require(payload['pid']==os.getppid(),'启动必须由实际父进程登记')
        observed=subprocess.run(['ps','-p',str(payload['pid']),'-o','lstart=,command='],capture_output=True,text=True,timeout=5);require(observed.returncode==0 and observed.stdout.strip(),'启动父进程身份不存在')
        state=ledger.apply('launched',{'id':payload['id'],'processIdentity':{'pid':payload['pid'],'observed':observed.stdout.strip(),'ledgerBeforeLaunch':checksum}})
        return {'authorized':True,'claim':state['claims'][payload['id']],'mockOnly':mode=='mock'}
    if action in ('seal','review'):
        claim=state['claims'][payload['id']]
        relative=Path(payload['output'])
        require(not relative.is_absolute()and '..'not in relative.parts,'输出路径不合法')
        output=study/relative
        if mode=='real':require(output==study/'runs'/payload['id'],'正式运行输出必须绑定固定槽')
        require(output.is_dir()and not output.is_symlink(),'运行输出不存在')
        receipt=json.loads((output/'execution-result.json').read_text());run=Path(receipt['traceDirectory']).resolve()
        require(run.is_relative_to(study),'Trace不属于本批私有目录')
        spec=importlib.util.spec_from_file_location('execution_evidence',Path(controller_module.__file__).with_name('execution-evidence.py'))
        evidence=importlib.util.module_from_spec(spec);spec.loader.exec_module(evidence)
        checked=evidence.audit(run,limit=claim['slot']['limit'],mock=mode=='mock')
        final=output/'final-snapshot.json';require(sha(final)==sha(run/'final-snapshot.json'),'产物副本与封存不符')
        cleanup=json.loads((output/'cleanup.json').read_text());require(cleanup['complete']and cleanup['traceSealed'],'执行清理或Trace未完成')
        if action=='seal':
            views=[{'id':payload['id']+'/final','kind':'final','artifactHash':sha(final)}]
            checkpoint=output/'checkpoint-snapshot.json'
            if checkpoint.exists():
                require(sha(checkpoint)==sha(run/'checkpoint-snapshot.json'),'检查点副本与封存不符')
                views.append({'id':payload['id']+'/checkpoint','kind':'checkpoint','artifactHash':sha(checkpoint)})
            ended=dt.datetime.fromisoformat(checked['ioFinish'].replace('Z','+00:00')).timestamp()
            seal={'id':payload['id'],'candidate':state['identities']['candidate'],'writersClosed':True,'manifestVerified':True,'traceHash':checked['traceHash'],'artifactHash':sha(final),'executionHash':checked['executionHash'],'cleanupHash':sha(output/'cleanup.json'),'forwardedGeneration':checked['forwardedGeneration'],'receivedAttempts':checked['receivedAttempts'],'countTokens':checked['countTokens'],'endedAt':ended,'gradeSeconds':0,'gradeState':'pending','views':views,'executionEvidence':checked}
            state=ledger.apply('seal',seal);return {'sealed':True,'claim':state['claims'][payload['id']]}
        review_file=output/'review.json';review=json.loads(review_file.read_text())
        require(review['artifactHash']==sha(final)and review['executionHash']==checked['executionHash'],'审查未绑定封存执行')
        require(review['reviewer']and review['classification']in ('PASS','N','H','UNKNOWN'),'人工审查身份或分类缺失')
        grading=json.loads((output/'grading-summary.json').read_text())
        require(grading['sharedSeconds']<=900 and grading['sharedSeconds']>=0,'评分共享窗口超限')
        require({r['view']for r in grading['views']}=={r['kind']for r in claim['seal']['views']},'评分视图缺失')
        for item in grading['views']:
            report=output/(item['view']+'-grade')/'result.json';require(sha(report)==item['sha256'],'评分报告改变')
            data=json.loads(report.read_text());expected=next(x['artifactHash']for x in claim['seal']['views']if x['kind']==item['view'])
            require(data['artifactSha256']==expected,'评分读了另一份产物')
        final_grade=json.loads((output/'final-grade/result.json').read_text())
        require(review['gradeHash']==sha(output/'final-grade/result.json'),'审查未绑定当前评分')
        if review['classification']=='PASS':
            require(final_grade['automaticChecksPassed']is True and checked['status']=='completed','自动失败或执行不完整不能判PASS')
            required={'publicContract','sourceChanges','userChanges','documentationExample','reportedChecks','traceIntegrity'}
            require(set(review['checks'])==required and all(x is True for x in review['checks'].values()),'人工审查项不完整')
        if review['classification']=='H':
            require(review['criticalClause']in ('H1','H2','H3','H4','H5')and review.get('violationEvidence'),'H缺少明确条款与实际见证')
            witness=json.loads(bound_file(study,review['violationEvidence']).read_text())
            require(witness['artifactHash']==sha(final)and witness.get('observedActual')and witness.get('expectedConstraint')and witness.get('references'),'H见证未绑定实际产物与约束')
            for item in witness['references']:bound_file(study,item)
            review['violationEvidenceHash']=review['violationEvidence']['sha256']
        review.update(id=payload['id'],reviewEvidenceHash=sha(review_file),gradeSeconds=grading['sharedSeconds'],gradingSummaryHash=sha(output/'grading-summary.json'))
        state=ledger.apply('review',review);return {'reviewed':True,'classification':review['classification'],'paused':state['paused'],'decisiveFailure':decisive_failure(state)}
    if action=='pause':
        require(payload.get('incident')and payload.get('evidence'),'暂停缺少实际证据')
        path=bound_file(study,payload.pop('evidence'));payload['evidenceHash']=sha(path)
        state=ledger.apply('pause',payload);return {'paused':state['paused']}
    raise Refused('该证据动作尚未实现，保持关闭')


if __name__=='__main__':
    data=json.load(sys.stdin);print(json.dumps(apply(data['study'],data['action'],data.get('payload',{}),data.get('mode','real')),ensure_ascii=False))
