"""对一份不可变Linux快照独立评分。当前入口仅供R2开发资格，不能启动模型。"""
from pathlib import Path
import base64
import fnmatch
import hashlib
import importlib.util
import json
import os
import sys
import time
import traceback
sys.dont_write_bytecode = True
from observations import observe, retained_baseline, regression_valid
from sandbox import Sandbox, save

_spec = importlib.util.spec_from_file_location('artifact_policy', Path(__file__).with_name('artifact-policy.py'))
policy_module = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(policy_module)


def source_files(task, manifest):
    files = {}
    for entry in manifest['files']:
        name = entry['path']; path = task / 'initial' / name
        if entry.get('type', 'file') == 'symlink':
            value = {'type':'symlink','mode':0o777,'target':entry['target']}
        else:
            raw = path.read_bytes()
            assert hashlib.sha256(raw).hexdigest() == entry['sha256']
            value = {'type':'file','mode':entry['mode'],'data':base64.b64encode(raw).decode()}
        files[name] = value
    return files


def native(case, label, framework, code):
    return observe(framework, case/(label+'.stdout'), case/(label+'.native.json'), code,
                   case/(label+'.native.xml'), case/(label+'.assertions.jsonl'))


def baseline(task, profile, label):
    if task.name.startswith('C7-'):
        q = task/'qualification-1'
    else:
        audits = sorted(task.glob('qualification-audit-*.json'))
        assert audits, '缺少逐题资格审计'
        q = task/json.loads(audits[-1].read_text())['referenceQualification']
    assert json.loads((q/'results.json').read_text())['qualified']
    case = q/'initial-1';index,step=next((i,x)for i,x in enumerate(profile['commands'])if x['label']==label)
    records = json.loads((case/'commands.json').read_text());record=next(x for x in records if x['label']==label)
    if step.get('framework') == 'bun':
        return observe('bun',case/f'{index}.stdout',case/f'{index}.native.json',record['exitCode'],case/(label+'.native.xml'),case/(label+'.assertions.jsonl'))
    return observe(step['framework'],case/f'{index}.stdout',case/f'{index}.native.json',record['exitCode'])


def regression_step(config, files):
    kind = config['framework']
    if kind == 'node':args=['node','--test','--test-reporter=/reporters/node.mjs',*files]
    elif kind == 'vitest':args=['node','node_modules/vitest/vitest.mjs','run','--reporter=/reporters/vitest.mjs',*files]
    elif kind == 'jest':args=['pnpm','--filter','listr2','run','test','--runInBand','--runTestsByPath',*[f.removeprefix('packages/listr2/') for f in files],'--reporters=/reporters/jest.cjs']
    elif kind == 'bun':args=['bun','test','--preload','/observer.ts',*[('./'+f)for f in files],'--reporter=junit','--reporter-outfile=/evidence/new-regression.native.xml']
    else:raise ValueError('未知回归框架')
    return {'label':'new-regression','framework':kind,'args':args}


def grade(study, task_id, artifact_path, out, seconds):
    started = time.monotonic();deadline = started + seconds
    task=study/('c7'if task_id.startswith('C7-')else'tasks')/task_id
    profile=json.loads((task/'qualification-profile.json').read_text());config=json.loads((task/'grading-profile.json').read_text());manifest=json.loads((task/'input-manifest.json').read_text())
    assert config['qualificationProfileSha256']==hashlib.sha256((task/'qualification-profile.json').read_bytes()).hexdigest()
    raw=artifact_path.read_bytes();artifact_hash=hashlib.sha256(raw).hexdigest();artifact=json.loads(raw)
    assert artifact['schema']==1 and artifact['requiresPausedWriters'] is True
    out.mkdir();initial=source_files(task,manifest);final=policy_module.normalize(artifact['files']);policy=config['policy']
    import subprocess
    root=task/'initial';git_before={'head':subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip(),'index':subprocess.check_output(['git','-C',str(root),'ls-files','--stage'],text=True)}
    protected=policy_module.check(initial,final,policy,git_before,artifact['git']);save(out/'protection.json',protected)
    result={'taskId':task_id,'artifactSha256':artifact_hash,'stage':'R2-development','gradeStatus':'unknown','codePassed':False,'regressionPassed':False,'examplePassed':False,'protection':protected,'commands':[],'manualReviewRequired':config['manualReviewRequired'],'criticalCandidates':[]}
    generated=lambda name:name not in policy['protectedPaths'] and any(fnmatch.fnmatchcase(name,p) or fnmatch.fnmatchcase(name+'/',p) for p in policy['generatedPaths'])
    # 丢弃产物中的生成文件，随后只按冻结原构建生成，不能利用旧dist冒充源码通过。
    clean={n:e for n,e in final.items()if not generated(n)}
    old_names=set(initial)
    test_names=sorted(n for n,e in clean.items()if n not in old_names and e['type']=='file'and any(fnmatch.fnmatchcase(n,p)for p in config['regression']['patterns']))
    additions={n:e for n,e in clean.items()if n not in old_names and any(n.startswith(root)for root in config['regression']['auxiliaryRoots'])}
    save(out/'regression-selection.json',{'tests':test_names,'files':sorted(additions)})
    current_reg=None
    try:
        with Sandbox(study,task,profile,out/'candidate',deadline,clean) as env:
            before=env.capture('before')
            def run(step):
                process=env.run(step);record={'label':step['label'],'process':process,'passed':process['code']==0 and not process['timedOut']};result['commands'].append(record)
                if process['timedOut']:raise TimeoutError('评分共享窗口耗尽')
                observation=None
                if step.get('framework')or step['label']=='target':
                    framework=step.get('framework','node')
                    try:observation=native(env.case,step['label'],framework,process['code']);save(env.case/(step['label']+'.observation.json'),observation)
                    except (ValueError,KeyError,OSError)as error:
                        record['nativeReportError']=str(error);record['passed']=False
                    if observation:
                        record['passed'] &= observation['passed']
                        if step['label'].startswith('baseline'):
                            record['passed'] &= retained_baseline(baseline(task,profile,step['label']),observation)
                        if step['label']=='target':
                            record['passed'] &= observation['tests']==profile['targetTests']
                            result['criticalCandidates']=[f for f in observation['failed']if f['name'].startswith('H4:')]
                            result['targetFailures']=observation['failed']
                after=env.capture(step['label']+'-after')
                before_source={n:e for n,e in before['files'].items()if not generated(n)}
                after_source={n:e for n,e in after['files'].items()if not generated(n)}
                if before_source!=after_source or before['git']['head']!=after['git']['head']or before['git']['index']!=after['git']['index']:
                    result['verificationMutation']={'step':step['label'],'reviewRequired':True}
                    raise RuntimeError('验证进程改写非生成源文件或Git')
                save(out/'result-progress.json',result)
                return record,observation
            build=profile['commands'][0];record,_=run(build)
            if not record['passed']:
                result['gradeStatus']='complete';result['reason']='build-failed'
            else:
                code_records=[]
                for step in profile['commands'][1:]:
                    if step['label'] in ('regression','example'):continue
                    record,_=run(step);code_records.append(record)
                result['codePassed']=all(x['passed']for x in code_records)
                if test_names:
                    _,current_reg=run(regression_step(config['regression'],test_names))
                if config.get('example'):
                    record,_=run(next(x for x in profile['commands']if x['label']=='example'));result['examplePassed']=record['passed']
                else:result['examplePassed']=True
                result['gradeStatus']='complete'
        if test_names and current_reg and current_reg['passed']:
            counterfactual={**initial,**additions}
            counterfactual={n:e for n,e in counterfactual.items()if not generated(n)}
            with Sandbox(study,task,profile,out/'counterfactual',deadline,counterfactual) as env:
                before=env.capture('before');build=env.run(profile['commands'][0])
                if build['timedOut']:raise TimeoutError('反事实构建超时')
                if build['code']==0:
                    step=regression_step(config['regression'],test_names);process=env.run(step)
                    if process['timedOut']:raise TimeoutError('反事实回归超时')
                    try:
                        old_reg=native(env.case,step['label'],step['framework'],process['code']);save(env.case/'regression-observation.json',old_reg)
                        result['regressionPassed']=regression_valid(old_reg,current_reg)
                    except (ValueError,KeyError,OSError)as error:result['counterfactualReportError']=str(error)
                after=env.capture('after')
                if {n:e for n,e in before['files'].items()if not generated(n)}!={n:e for n,e in after['files'].items()if not generated(n)}or before['git']['head']!=after['git']['head']or before['git']['index']!=after['git']['index']:
                    raise RuntimeError('反事实验证改写源文件或Git')
    except Exception as error:
        result['gradeStatus']='unknown';result['error']=str(error);(out/'error.txt').write_text(traceback.format_exc())
    result['seconds']=time.monotonic()-started
    if result['seconds']>seconds:result.update(gradeStatus='unknown',error='超过评分共享窗口（含清理）')
    assert hashlib.sha256(artifact_path.read_bytes()).hexdigest()==artifact_hash,'封存产物改变'
    result['automaticChecksPassed']=bool(result['gradeStatus']=='complete'and result['codePassed']and result['regressionPassed']and result['examplePassed']and protected['passed'])
    result['releaseClassification']=None
    save(out/'result.json',result);return result


if __name__=='__main__':
    study=Path(sys.argv[1]).resolve();task_id=sys.argv[2];artifact=Path(sys.argv[3]).resolve();out=Path(sys.argv[4]).resolve();seconds=float(sys.argv[5])
    assert sys.argv[6:] == ['--development'] and 0 < seconds <= 720
    auth=json.loads((study/'authorization.json').read_text());assert auth['T1']is None and json.loads((study/'engineering-admission.json').read_text())['stage']=='R2'
    from datetime import datetime,timezone
    assert datetime.now(timezone.utc)<datetime.fromisoformat(auth['preparationDeadline'])
    assert out.is_relative_to(study) and artifact.is_relative_to(study)
    result=grade(study,task_id,artifact,out,seconds);print(json.dumps(result));sys.exit(0 if result['automaticChecksPassed']else 1)
