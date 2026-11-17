"""故意退回错误设施实现，要求实际行为断言检出；不把加载失败当检出。"""
from pathlib import Path
import json,shutil,subprocess,os,sys,hashlib

study=Path(sys.argv[1]).resolve();out=study/sys.argv[2];out.mkdir();repo=Path(__file__).resolve().parents[3]
cases=['proxy-cap50','proxy-late','controller-duplicate','controller-n-as-env'];rows=[]
for case in cases:
    folder=out/case;folder.mkdir();source=folder/'source';source.mkdir()
    shutil.copytree(repo/'src',source/'src')
    for name in ('release-r3','container'):shutil.copytree(repo/'scripts/eval'/name,source/'scripts/eval'/name,ignore=shutil.ignore_patterns('__pycache__'))
    root=source/'scripts/eval/release-r3'
    env=os.environ.copy();env['AXI_TEST_EVIDENCE_DIR']=str(folder/'traces');env['PYTHONDONTWRITEBYTECODE']='1'
    if case.startswith('proxy'):
        path=root/'relay.ts';text=path.read_text()
        if case=='proxy-cap50':
            anchor='  run.requests++;';assert text.count(anchor)==1
            text=text.replace(anchor,anchor+'\n  if(!countOnly&&run.budget.receivedGeneration>50)return new Response("mutant count cap",{status:400});')
            pattern='超过50次仍完整转发'
        else:
            anchor='for(const c of run.controllers)c.abort(new DOMException("R3 execution deadline","TimeoutError"));';assert text.count(anchor)==1;text=text.replace(anchor,'void 0;')
            text=text.replace('Math.min(360000, run.budget.remainingMs())','360000')
            policy=root/'policy.ts';p=policy.read_text().replace('Math.max(0, this.monotonicDeadline - this.mono())','Math.max(1, this.monotonicDeadline - this.mono())');policy.write_text(p)
            fixture=root/'relay.test.ts';t=fixture.read_text().replace('delayMs:5000','delayMs:500');fixture.write_text(t);pattern='长请求到截止中断'
        path.write_text(text)
        args=['bun','test',str(root/'relay.test.ts'),'-t',pattern]
    else:
        path=root/'controller.py';text=path.read_text()
        if case=='controller-duplicate':
            for line in ["    require(all('review' in c for c in state['claims'].values()), '上一尝试尚未封存和审查')", "        require(not any(c['logicalId'] == slot['id'] for c in state['claims'].values()), '未决尝试不能隐式重跑')", "        require(slot['id'] not in state['claims'] and len(state['claims']) < 73, '重复claim或超过73次')"]:
                assert line in text;text=text.replace(line,'')
        else:
            anchor="    elif action == 'environment-begin':";assert text.count(anchor)==1
            text=text.replace(anchor,anchor+"\n        if state['claims'][payload['target']]['review']['classification']=='N':return state")
        path.write_text(text);args=['python3','-B',str(root/'controller-qualification.py'),str(folder/'qualification')]
    hashes={str(p.relative_to(source)):hashlib.sha256(p.read_bytes()).hexdigest() for p in source.rglob('*') if p.is_file()};(folder/'source-hashes.json').write_text(json.dumps(hashes,indent=2)+'\n')
    r=subprocess.run(args,env=env,capture_output=True,text=True,timeout=60);(folder/'stdout').write_text(r.stdout);(folder/'stderr').write_text(r.stderr)
    assert r.returncode!=0,(case,'相反实现未被检出')
    assert not any(word in r.stderr for word in ('Cannot find module','ModuleNotFoundError','SyntaxError','ImportError')),r.stderr
    if case.startswith('proxy'):assert 'expect(received)' in r.stderr and ('Expected: 200' in r.stderr or 'Expected: 502' in r.stderr),r.stderr
    else:assert 'AssertionError: 应拒绝但接受' in r.stderr,r.stderr
    rows.append({'case':case,'qualified':True,'exitCode':r.returncode,'behaviorAssertion':True});(out/'results.json').write_text(json.dumps({'qualified':len(rows)==len(cases),'rows':rows},ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'qualified':True,'mutants':len(rows)}))
