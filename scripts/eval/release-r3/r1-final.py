"""按最终设施代码执行固定五次资格；失败即停，保留所有已产生证据。"""
from pathlib import Path
import hashlib,json,os,shutil,subprocess,sys,time

study=Path(sys.argv[1]).resolve();label=sys.argv[2];bundle=sys.argv[3]
assert label.startswith('r1-final-') and bundle.startswith('bundle-')
revision=int(label.rsplit('-',1)[1]);offset=(revision-1)*100
out=study/label;out.mkdir();repo=Path(__file__).resolve().parents[3]
env={**os.environ,**json.loads((study/'toolchain/verification.json').read_text())['env']}
env['PATH']+=':/Applications/Docker.app/Contents/Resources/bin'
env.update(PYTHONDONTWRITEBYTECODE='1',ANTHROPIC_API_KEY='synthetic-local-key',ANTHROPIC_BASE_URL='http://127.0.0.1:1',AXI_EVAL_IMAGE='sha256:2c28b2b381ad0647f6a95afbd781e0d27e06a892fd40a164ac0dcb753fb92ba1',AXI_RETRY_WINDOW_MS='1',AXI_HOST_TEST_MARKER='must-not-enter-subject')
def files():
    return sorted({p for root in [repo/'scripts/eval',repo/'src'] for p in root.rglob('*') if p.is_file() and p.suffix in ('.ts','.py','.mjs','.cjs') and '__pycache__' not in p.parts})
source={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in files()}
archive=out/'source';archive.mkdir()
for path,digest in source.items():target=archive/digest;target.write_bytes(Path(path).read_bytes())
(out/'source.json').write_text(json.dumps(source,indent=2)+'\n')
def stable():
    assert [str(p) for p in files()]==list(source),'资格期间设施文件集合改变'
    assert all(hashlib.sha256(Path(p).read_bytes()).hexdigest()==h for p,h in source.items()),'资格期间设施源码改变'
steps=[]
steps.append(('typecheck',['bun','x','--no-install','tsc','--noEmit','--project','scripts/eval/release-r3/tsconfig.json']))
for i in range(5):
    steps.extend([
      (f'units-{i+1}',['bun','test',*[f'scripts/eval/release-r3/{n}.test.ts' for n in ('policy','chunks','json-lines','relay')]]),
      (f'controller-{i+1}',['python3','-B','scripts/eval/release-r3/controller-qualification.py',str(study/f'controller-qualification-{4+i+offset}')]),
      (f'mutants-{i+1}',['python3','-B','scripts/eval/release-r3/mutant-qualification.py',str(study),f'mutant-qualification-{2+i+offset}']),
      (f'evidence-{i+1}',['python3','-B','scripts/eval/release-r3/evidence-qualification.py',str(study),f'evidence-qualification-{2+i+offset}'])])
steps.append(('adapters',['bun','scripts/eval/release-r3/adapter-cli.ts',str(study),f'c3-adapter-cli-{2+offset}',bundle]))
for i in range(5):
    steps.extend([
      (f'auto-{i+1}',['bun','scripts/eval/release-r3/integration.ts',str(study),f'integration-{3+i+offset}',bundle]),
      (f'runtime-{i+1}',['bun','scripts/eval/release-r3/runtime-qualification.ts',str(study),f'runtime-qualification-{10+i+offset}',bundle,'short']),
      (f'guard-{i+1}',['bun','scripts/eval/release-r3/guard-qualification.ts',str(study),f'guard-qualification-{10+i+offset}',bundle]),
      (f'cancel-{i+1}',['bun','scripts/eval/release-r3/cancel-qualification.ts',str(study),f'cancel-qualification-{10+i+offset}',bundle]),
      (f'orphan-{i+1}',['bun','scripts/eval/release-r3/orphan-qualification.ts',str(study),f'orphan-qualification-{10+2*i+offset}',bundle,'crash']),
      (f'write-failure-{i+1}',['bun','scripts/eval/release-r3/orphan-qualification.ts',str(study),f'orphan-qualification-{11+2*i+offset}',bundle,'write-failure']),
      *[(f'health-{actor}-{i+1}',['bun','scripts/eval/release-r3/pipeline-one.ts',str(study),'health',actor,f'r3-r1-{revision}-{i+1}']) for actor in ('v0','v1','claude')],
      (f'large-{i+1}',['bun','scripts/eval/release-r3/runtime-qualification.ts',str(study),f'runtime-qualification-{20+i+offset}',bundle,'large'])])
(out/'plan.json').write_text(json.dumps({'steps':steps,'repeats':5,'mockOnly':True,'bundle':bundle},indent=2)+'\n')
rows=[]
for name,args in steps:
    stable();disk=os.statvfs(study);assert disk.f_bavail*disk.f_frsize>=9*1024**3,'保全空间不足'
    folder=out/name;folder.mkdir();run_env={**env,'AXI_TEST_EVIDENCE_DIR':str(folder/'traces')}
    started=time.time();print(json.dumps({'step':name,'state':'running'}),flush=True)
    with (folder/'stdout').open('wb') as stdout,(folder/'stderr').open('wb') as stderr:
        try:result=subprocess.run(args,cwd=repo,env=run_env,stdout=stdout,stderr=stderr)
        except Exception as error:
            (folder/'failure.json').write_text(json.dumps({'error':str(error),'command':args},indent=2)+'\n');raise
    row={'step':name,'exitCode':result.returncode,'seconds':time.time()-started};rows.append(row)
    (folder/'result.json').write_text(json.dumps(row,indent=2)+'\n')
    (out/'results.json').write_text(json.dumps({'qualified':len(rows)==len(steps) and all(x['exitCode']==0 for x in rows),'steps':len(steps),'rows':rows},indent=2)+'\n')
    print(json.dumps(row),flush=True);stable()
    if result.returncode:raise SystemExit(result.returncode)
print(json.dumps({'qualified':True,'steps':len(rows),'repeats':5}),flush=True)
