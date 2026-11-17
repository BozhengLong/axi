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
sys.path.append(str(Path(__file__).resolve().parent.parent/'release-r2'))
from inputs import verify_initial


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


def grading_change(study,path,old=None):
    path=Path(path).resolve();here=Path(controller_module.__file__).parent.resolve()
    if path.is_relative_to(here):
        rel=path.relative_to(here).as_posix()
        return rel in ('grade-artifact.py','observations.py','bun-report.py','artifact-policy.py','path_patterns.py','sandbox.py','restore.mjs') or rel.startswith(('reporters/','grading/'))
    if path.is_relative_to(study):
        parts=path.relative_to(study).parts
        if len(parts)>=3 and parts[0]in ('tasks','c7'):
            if parts[2]=='qualification-profile.json':
                require(old and old.get('archive'),'原评分配置缺少源归档')
                before=json.loads(bound_file(study,{'path':old['archive'],'sha256':old['sha256']}).read_text());after=json.loads(path.read_text())
                fixed=('taskId','image','dependencyMounts','dependencyVolume','dependencyPaths','environment','cacheTmpfs','taskStorage','linuxSymlinkMode','requestLimit','maxSeconds','originalTests','originalTapLeaves','originalTapSkips','originalMochaPending')
                require(all(before.get(k)==after.get(k)for k in fixed),'评分修复改变运行环境或旧测试门槛')
                return True
            return parts[2]in ('grading-profile.json','negative-controls.json')or parts[2].endswith('-patch.json')or parts[2]=='qualification-material'
    return False


def verify_sources(study,manifest,repair=None):
    old_index=json.loads(bound_file(study,manifest['facilityIndex']).read_text());require(digest(old_index)==manifest['facilityHash'],'原设施总身份不符')
    index=old_index
    if repair and repair.get('completedAt'):
        index=json.loads(bound_file(study,repair['facilityIndex']).read_text());require(digest(index)==repair['facilityHash'],'恢复设施总身份不符')
    require(index['files'],'设施清单为空');old_by_path={e['path']:e for e in old_index['files']};new_by_path={e['path']:e for e in index['files']}
    require(len(old_by_path)==len(old_index['files'])and len(new_by_path)==len(index['files']),'设施清单路径重复')
    def permitted(path,old):
        require(grading_change(study,path,old),'修复越出评分设施: '+path)
        if repair and repair['scope']=='tasks':
            source=Path(path).resolve();require(source.is_relative_to(study),'共享评分代码变更必须采用shared影响范围')
            parts=source.relative_to(study).parts;require(len(parts)>1 and parts[1]in repair['scopeTasks'],'修复改变未声明任务')
        return True
    if repair and repair.get('completedAt'):
        for path in old_by_path.keys()|new_by_path.keys():
            if old_by_path.get(path,{}).get('sha256')!=new_by_path.get(path,{}).get('sha256'):permitted(path,old_by_path.get(path))
    for entry in index['files']:
        path=Path(entry['path']);valid=path.is_file()and not path.is_symlink()and sha(path)==entry['sha256']
        if not valid and repair and not repair.get('completedAt'):
            permitted(str(path),entry)
        else:require(valid,'设施源码改变: '+str(path))
    return index


def verify_admission(study,manifest,repair=None):
    require(manifest['schema']==3 and manifest['qualificationComplete']is True,'完整准备未通过')
    require(not manifest['identities'].get('mockOnly'),'正式准入不能使用合成身份')
    require(manifest['identities']['v0']=='963704be97150e268edd3fda484d68e0a18a1f8b' and manifest['identities']['image']=='sha256:2c28b2b381ad0647f6a95afbd781e0d27e06a892fd40a164ac0dcb753fb92ba1','基线或镜像身份改变')
    require(manifest['commit']==manifest['remoteCommit'],'冻结提交未推送')
    auth=json.loads((study/'authorization.json').read_text());require(manifest['T0']==auth['T0'],'T0身份不符')
    require(manifest['identities']['candidate']=='e684620d1fa9109fcbcf442033ed97323cf76716','候选不符')
    require(manifest['identities']['sourceHash']=='db1ce2d12928db759b4d43a9dc663a5eab490d733673166d33daf04306580391','产品源码不符')
    require(manifest['identities']['model']=='claude-opus-5-5'and manifest['identities']['claude']=='2.1.322','冻结模型或参照不符')
    required={'engineering','taskPackage','c7','controller','pipeline','capture','dependencies','resourcePolicy','evidenceAudit','reuse'}
    require(set(manifest['proofs'])==required,'准备证明种类不完整')
    proofs={key:json.loads(bound_file(study,value).read_text())for key,value in manifest['proofs'].items()}
    require(all(v.get('qualified')is True for v in proofs.values()),'准备存在未通过项')
    require(proofs['pipeline']['taskCases']==60 and proofs['pipeline']['c7Cases']==2 and proofs['pipeline']['healthCases']==3,'65条CLI资格不完整')
    require(len(proofs['taskPackage']['tasks'])==20 and all(t['qualified'] is True and t['repeatRuleSatisfied'] is True for t in proofs['taskPackage']['tasks']),'20题参考资格不完整')
    require(set(proofs['engineering']['runtimeChecks'])=={f'RT{i:02}' for i in range(1,13)} and all(proofs['engineering']['runtimeChecks'].values()),'运行策略资格缺失')
    require(proofs['controller']['nativeIntegrationQualified']is True,'控制器实际执行接线未取得资格')
    require(proofs['engineering']['candidate']==manifest['identities']['candidate'],'工程证明不是当前候选')
    verify_sources(study,manifest,repair)
    require([t['id']for t in manifest['tasks']]==[f'U{i:02}'for i in range(1,21)],'20题顺序错误')
    require([t['id']for t in manifest['c7Tasks']]==['C7-L','C7-O'],'C7题目不完整或顺序错误')
    require(manifest['healthTask']['id']=='health','健康探针绑定缺失')
    for task in manifest['tasks']+manifest['c7Tasks']+[manifest['healthTask']]:
        binding=json.loads(bound_file(study,task['binding']).read_text())
        require(digest(binding)==task['manifestHash']and binding['admitted']is True,'题目绑定未准入')
        for entry in binding['files']:bound_file(study,entry)
        initial_manifest=json.loads(bound_file(study,binding['inputManifest']).read_text())
        initial=study/binding['initial'];require(initial.resolve()==initial and initial.is_relative_to(study),'题目初态路径不合法')
        verify_initial(initial,initial_manifest,binding['gitIdentity'])
    return proofs


def resources(study,manifest,initial=False):
    policy=json.loads(bound_file(study,manifest['proofs']['resourcePolicy']).read_text())
    stat=os.statvfs(study);available=stat.f_bavail*stat.f_frsize
    require(available >= (policy['minimumFreeBytes'] if initial else 9*1024**3),'宿主磁盘低于冻结阈值')
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
        manifest=state['manifest'] or json.loads((study/'release-manifest.json').read_text())
        if action not in ('pause','close'):verify_admission(study,manifest,state.get('repair'))
        require(state['identities']==manifest['identities'],'账本身份不符')
    else:
        require(state['identities'].get('mockOnly')is True,'模拟入口不能使用正式账本');manifest=state['manifest']
    if action=='freeze':
        require(mode=='real','模拟冻结由资格驱动构造');state=ledger.apply('freeze',manifest);return {'state':state}
    if action=='begin':
        require(mode=='real','模拟T1由资格驱动构造');resources(study,manifest,initial=True);state=ledger.apply('begin',{});return {'state':state}
    if action=='claim':
        slot=next_slot(state,dt.datetime.now(dt.timezone.utc).timestamp())
        if mode=='real':
            resources(study,manifest)
            spec=importlib.util.spec_from_file_location('dependency_audit',Path(__file__).with_name('dependency-audit.py'));dependency=importlib.util.module_from_spec(spec);spec.loader.exec_module(dependency)
            dependency.verify(study,json.loads(bound_file(study,manifest['proofs']['dependencies']).read_text()),slot['task'])
        request={'id':slot['id'],'identities':state['identities'],'manifestHash':digest(state['manifest']),'facilityHash':state['repair']['facilityHash']if state['repair']and state['repair'].get('completedAt')else state['manifest']['facilityHash'],'requestLimit':None,'limitMode':'unlimited','attempt':slot['attempt']}
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
        checked=evidence.audit(run,mock=mode=='mock')
        final=output/'final-snapshot.json';require(sha(final)==sha(run/'final-snapshot.json'),'产物副本与封存不符')
        cleanup=json.loads((output/'cleanup.json').read_text());require(cleanup['complete']and cleanup['traceSealed'],'执行清理或Trace未完成')
        if action=='seal':
            views=[{'id':payload['id']+'/final','kind':'final','artifactHash':sha(final)}]
            checkpoint=output/'checkpoint-snapshot.json'
            if checkpoint.exists():
                require(sha(checkpoint)==sha(run/'checkpoint-snapshot.json'),'检查点副本与封存不符')
                views.append({'id':payload['id']+'/checkpoint','kind':'checkpoint','artifactHash':sha(checkpoint)})
            ended=dt.datetime.fromisoformat(checked['ioFinish'].replace('Z','+00:00')).timestamp()
            termination='completed' if checked['status']=='completed' else 'deadline' if checked['status']=='task_timeout' else 'retry_exhausted' if checked['status']=='retry_exhausted' else 'upstream_interrupted' if checked.get('externalTerminalCause') else checked['status']
            guard=json.loads((run/'runtime-guard.json').read_text());require(guard['closed'] is True and guard['deadline']==int(claim['executionDeadline']*1000),'运行监控未绑定截止')
            stop=json.loads((run/'runtime-stop.json').read_text()) if (run/'runtime-stop.json').exists() else None
            if stop and stop['reason']=='resource':termination='resource'
            seal={'termination':termination,'deadlineEnforced':bool(stop and stop['reason']=='deadline' and stop['processStoppedMs']<=5000),'id':payload['id'],'candidate':state['identities']['candidate'],'writersClosed':True,'manifestVerified':True,'traceHash':checked['traceHash'],'artifactHash':sha(final),'executionHash':checked['executionHash'],'cleanupHash':sha(output/'cleanup.json'),'forwardedGeneration':checked['forwardedGeneration'],'receivedAttempts':checked['receivedAttempts'],'countTokens':checked['countTokens'],'endedAt':ended,'gradeSeconds':0,'gradeState':'pending','views':views,'output':str(relative),'executionEvidence':checked}
            state=ledger.apply('seal',seal);return {'sealed':True,'claim':state['claims'][payload['id']]}
        review_file=output/'review.json';review=json.loads(review_file.read_text())
        require(review['artifactHash']==sha(final)and review['executionHash']==checked['executionHash'],'审查未绑定封存执行')
        require(review['reviewer']and review['classification']in ('PASS','N','H','UNKNOWN','ENV_INTERRUPTED'),'人工审查身份或分类缺失')
        grading=json.loads((output/'grading-summary.json').read_text())
        require(grading['sharedSeconds'] <= (300 if claim['slot']['kind'] in ('health','recovery-health') else 900) and grading['sharedSeconds']>=0,'评分共享窗口超限')
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
        if review['classification']=='ENV_INTERRUPTED':
            witness=json.loads(bound_file(study,review['externalEvidence']).read_text())
            require(checked.get('externalTerminalCause') and witness['cause']==checked['externalTerminalCause'] and witness['executionHash']==checked['executionHash'],'外部中断缺少封存直接见证')
            require(review.get('protectionReviewed') is True and review.get('confirmedH') is False,'外部中断必须先完成保护审查')
            review.update(externalCauseConfirmed=True,externalEvidenceHash=review['externalEvidence']['sha256'])
        review.update(allChecksPassed=review['classification']=='PASS',cleanUpstream=checked['externalEvents']==0 and checked.get('transportErrors',0)==0 and not checked['observerErrors'])
        review.update(id=payload['id'],reviewEvidenceHash=sha(review_file),gradeSeconds=grading['sharedSeconds'],gradingSummaryHash=sha(output/'grading-summary.json'))
        state=ledger.apply('review',review);return {'reviewed':True,'classification':review['classification'],'paused':state['paused'],'decisiveFailure':decisive_failure(state)}
    if action=='environment-begin':
        incident=bound_file(study,payload['incident']);review=state['claims'][payload['target']]['review']
        witness=json.loads(incident.read_text());require(witness['target']==payload['target'] and witness['externalEvidenceHash']==review['externalEvidenceHash'],'恢复事件未绑定外部见证')
        state=ledger.apply('environment-begin',{'target':payload['target'],'incidentHash':sha(incident),'externalEvidenceHash':review['externalEvidenceHash']})
        return {'recovery':state['recoveries'][-1]}
    if action=='pause':
        require(payload.get('incident')and payload.get('evidence'),'暂停缺少实际证据')
        path=bound_file(study,payload.pop('evidence'));payload['evidenceHash']=sha(path)
        state=ledger.apply('pause',payload);return {'paused':state['paused']}
    if action=='repair-begin':
        require(payload.get('impact')and payload.get('reproduction'),'修复缺少影响审计或复现')
        impact_path=bound_file(study,payload.pop('impact'));impact=json.loads(impact_path.read_text());reproduction=bound_file(study,payload.pop('reproduction'))
        require(impact['kind']=='measurement'and impact['sameContract']is True,'只允许同契约评分测量修复')
        require(impact['contractsHash']==digest(state['manifest']['tasks']),'修复改变原任务契约')
        expected=[x['id']for c in state['claims'].values()if 'seal'in c and(impact['scope']=='shared'or c['slot']['task']in impact['scopeTasks'])for x in c['seal']['views']]
        require(sorted(impact['affectedViews'])==sorted(expected),'影响范围未覆盖全部封存视图')
        old=[]
        for view in expected:
            slot_id,kind=view.split('/');sealed=state['claims'][slot_id]['seal'];output=study/sealed['output'];path=output/(kind+'-grade')/'result.json'
            old.append({'view':view,'artifactHash':next(x['artifactHash']for x in sealed['views']if x['kind']==kind),'path':str(path.relative_to(study)),'sha256':sha(path)if path.exists()else None})
        repair_id=digest({'at':dt.datetime.now(dt.timezone.utc).isoformat(),'impact':sha(impact_path)})[:20]
        request={'repairId':repair_id,'sameContract':True,'identities':state['identities'],'contractsHash':impact['contractsHash'],'affectedViews':expected,'scope':impact['scope'],'scopeTasks':impact.get('scopeTasks',[]),'impactAuditHash':sha(impact_path),'reproductionHash':sha(reproduction),'estimateSeconds':payload['estimateSeconds'],'oldGrades':old,'oldGradesHash':digest(old)}
        state=ledger.apply('repair-begin',request);return {'repair':state['repair']}
    if action=='repair-complete':
        repair=state['repair'];require(repair and not repair.get('completedAt'),'没有待完成评分修复')
        qualification_path=bound_file(study,payload['qualification']);qualification=json.loads(qualification_path.read_text());regrade_path=bound_file(study,payload['regrade']);regrade=json.loads(regrade_path.read_text());cleanup_path=bound_file(study,payload['cleanup']);cleanup=json.loads(cleanup_path.read_text())
        require(qualification['qualified']is True and qualification['repeats']==5 and qualification['contractsHash']==repair['contractsHash'],'受影响五次资格不完整或改变契约')
        require(cleanup['complete']is True,'修复评分资源未清理')
        require(sorted(r['id']for r in regrade['views'])==sorted(repair['affectedViews']),'没有统一重评所有受影响视图')
        for row in regrade['views']:
            report=json.loads(bound_file(study,row['report']).read_text());slot_id,kind=row['id'].split('/');sealed=state['claims'][slot_id]['seal'];artifact=next(x['artifactHash']for x in sealed['views']if x['kind']==kind)
            require(report['artifactSha256']==artifact and report['gradeStatus']=='complete','重评改变执行产物或仍不可判定')
        for old in repair['oldGrades']:
            path=study/old['path'];require((sha(path)if path.exists()else None)==old['sha256'],'旧评分被覆盖')
        active_index=json.loads(bound_file(study,payload['facilityIndex']).read_text());active_hash=digest(active_index)
        active_repair={**repair,'completedAt':dt.datetime.now(dt.timezone.utc).timestamp(),'facilityIndex':payload['facilityIndex'],'facilityHash':active_hash};verify_sources(study,manifest,active_repair)
        reviews=[]
        for entry in regrade['reviews']:
            path=bound_file(study,entry);review=json.loads(path.read_text());slot_id=review['id'];sealed=state['claims'][slot_id]['seal']
            require(review['artifactHash']==sealed['artifactHash']and review['executionHash']==sealed['executionHash'],'重审替换执行身份')
            final_row=next(x for x in regrade['views']if x['id']==slot_id+'/final');final_path=bound_file(study,final_row['report']);grade=json.loads(final_path.read_text());require(review['gradeHash']==sha(final_path),'重审没有使用当前评分')
            if review['classification']=='PASS':require(grade['automaticChecksPassed']is True and sealed['executionEvidence']['status']=='completed' and set(review['checks'])=={'publicContract','sourceChanges','userChanges','documentationExample','reportedChecks','traceIntegrity'} and all(value is True for value in review['checks'].values()),'失败产物或缺审查项不能在重审中判PASS')
            if review['classification']=='H':
                witness_path=bound_file(study,review['violationEvidence']);witness=json.loads(witness_path.read_text());require(review['criticalClause']in ('H1','H2','H3','H4','H5')and witness['artifactHash']==sealed['artifactHash']and witness.get('observedActual')and witness.get('expectedConstraint')and witness.get('references'),'重审H缺少实际见证')
                for item in witness['references']:bound_file(study,item)
                review['violationEvidenceHash']=sha(witness_path)
            review['reviewEvidenceHash']=sha(path);reviews.append(review)
        request={'reviews':reviews,'contractsHash':repair['contractsHash'],'identities':state['identities'],'regradedViews':[r['id']for r in regrade['views']],'repeats':5,'qualificationPassed':True,'qualificationHash':sha(qualification_path),'regradeAuditHash':sha(regrade_path),'oldGradesHash':repair['oldGradesHash'],'facilityHash':active_hash,'facilityIndex':payload['facilityIndex'],'cleanupHash':sha(cleanup_path)}
        state=ledger.apply('repair-complete',request);return {'repair':state['repair'],'paused':state['paused']}
    if action=='close':
        report_path=bound_file(study,payload['report']);report=json.loads(report_path.read_text());cleanup_path=bound_file(study,payload['cleanup']);cleanup=json.loads(cleanup_path.read_text())
        require(cleanup['complete']is True,'关闭前资源未清理')
        gates=report['gates'];require(set(gates)=={'G'+str(i)for i in range(7)},'发布门槛表不完整')
        failures=[]
        for gate,row in gates.items():
            require(row['status']in ('PASS','FAIL','UNKNOWN'),'未知门槛状态')
            if row['status']!='UNKNOWN':require(row.get('evidence'),'确定门槛状态缺少证据')
            for entry in row.get('evidence',[]):bound_file(study,entry)
            if row['status']=='FAIL':require(row.get('evidence'),'确定门槛失败缺少证据');failures.append({'gate':gate,'evidenceHash':digest(row['evidence'])})
        request={'verdict':report['verdict'],'reportHash':sha(report_path),'cleanupHash':sha(cleanup_path),'allGatesPassed':all(row['status']=='PASS'for row in gates.values()),'requiredGateFailures':failures}
        state=ledger.apply('close',request);return {'closure':state['closure']}
    raise Refused('该证据动作尚未实现，保持关闭')


def mirror(study):
    study=Path(study).resolve();directory=study/'formal-controller'
    if not(directory/'controller-events.jsonl').exists():return
    state,checksum=read_state(directory);path=study/'status.json';prior=json.loads(path.read_text())
    prior.pop('realCliStarts',None);prior.pop('generationRequests',None)
    prior.update(phase=state['phase'],T1=dt.datetime.fromtimestamp(state['T1'],dt.timezone.utc).isoformat()if state['T1']else None,controllerHash=checksum,realCliClaims=len(state['claims']),sealedNativeRuns=sum('seal'in c for c in state['claims'].values()),forwardedGeneration=sum(c.get('seal',{}).get('forwardedGeneration',0)for c in state['claims'].values()),paused=state['paused'],closure=state['closure'])
    temp=study/('stage-'+str(os.getpid())+'.tmp')
    with temp.open('x')as f:json.dump(prior,f,ensure_ascii=False,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
    os.chmod(temp,0o600);os.replace(temp,path)


if __name__=='__main__':
    data=json.load(sys.stdin);result=apply(data['study'],data['action'],data.get('payload',{}),data.get('mode','real'))
    if data.get('mode','real')=='real':mirror(data['study'])
    print(json.dumps(result,ensure_ascii=False))
