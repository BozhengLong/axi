"""从公开边界生成评分配置草稿。此步骤不准入题包，也不启动模型。"""
from pathlib import Path
import fnmatch
import re
import hashlib
import json
import subprocess
import sys
sys.dont_write_bytecode = True
from sandbox import save

study = Path(sys.argv[1]).resolve()
task_id = sys.argv[2]
task = study / ('c7' if task_id.startswith('C7-') else 'tasks') / task_id
assert task.is_dir() and task.parent.parent == study
profile = json.loads((task / 'qualification-profile.json').read_text())
manifest = json.loads((task / 'input-manifest.json').read_text())
paths = [x['path'] for x in manifest['files']]
readonly_config = lambda n: (Path(n).name in ('package.json', 'pnpm-lock.yaml', 'package-lock.json', 'bun.lock', 'bun.lockb') or Path(n).name.startswith(('tsconfig', 'jest.config', 'vitest.config')))
source, generated = [], []
if task_id in ('T01','T11','T20'):
    source = ['lib/**','typings/**'] + ([] if task_id == 'T20' else ['index.js','esm.mjs'])
elif task_id in ('T02','T09','T10','T14','T15','T17','T19'):
    source = ['src/**']; generated = ['dist/**','coverage/**']
    if task_id in ('T14','T17'):generated += ['.tap/**', '.tshy-build/**', 'c\uf03a/x/y/z/\uf03c\uf07c\uf03e\uf03f\uf03a.txt']
elif task_id in ('T03','T06','T07','T08','T13'):
    source = ['lib/**']
elif task_id in ('T04','T12','T18'):
    source = ['packages/csv-stringify/lib/**'] if task_id == 'T18' else ['packages/*/lib/**']
    generated = ['packages/*/dist/**','demo/webpack/dist/**','demo/webpack-ts/dist/**']
elif task_id in ('T05','T16'):
    source = ['packages/*/src/**']; generated = ['packages/*/build/**','examples/*/build/**','documentation/build/**','documentation/.docusaurus/**','coverage/**','**/*.tsbuildinfo','**/*.tmp.csv']
elif task_id == 'C7-L':
    source = ['packages/listr2/src/renderer/jsonl/**']; generated = ['packages/*/dist/**','packages/*/junit.xml','**/*.tsbuildinfo']
elif task_id == 'C7-O':
    source = ['src/**']
else:raise ValueError('未知任务')
if task_id in ('T02','T09','T10','T14','T15','T17','T19'):
    generated += ['*.tsbuildinfo','**/*.tsbuildinfo']
readme = 'Readme.md' if task_id in ('T01','T11','T20') else 'README.md'
example = next((x['args'][-1] for x in profile['commands'] if x['label']=='example'), None)
regression_allowed = ['eval-regression/**']
if task_id in ('T02','T09','T19'):regression_allowed += ['test/release-*.test.ts']
if task_id == 'T17':regression_allowed += ['test/**']
if task_id == 'C7-L':regression_allowed = ['packages/listr2/tests/**']
if task_id == 'C7-O':regression_allowed = ['tests/**']
allowed = source + regression_allowed
if not task_id.startswith('C7-'):allowed += [readme] + ([example] if example else [])
else:
    allowed += ['README.md']
    if task_id == 'C7-L':allowed += ['website/docs/renderer/jsonl.md','examples/c6-consumer/run.ts']
match = lambda n, patterns: any(fnmatch.fnmatchcase(n,p) for p in patterns)
protected = [n for n in paths if (not match(n,source+[readme]) and not match(n,generated)) or readonly_config(n) or (any(part in ('test','tests','__tests__','__fixtures__','__mocks__') for part in Path(n).parts) or bool(re.search(r'(?:^|[./])(?:test|spec)(?:-d)?\.[cm]?[jt]sx?$',n))) or n.startswith(('eval/','notes/','c6/','c7/')) or (n.startswith('demo/') and n.endswith('.html'))]
json_changes = {}
if task_id == 'T08':protected.remove('package.json');json_changes = {'package.json':['/exports/.~1jsonl']}
if task_id.startswith('C7-'):protected = sorted(set(protected)|set(profile['protectedPaths']))
regression = {'framework':'node','patterns':['eval-regression/release-*.mjs'],'auxiliaryRoots':['eval-regression/']}
if task_id == 'T02':regression = {'framework':'vitest','patterns':['test/release-*.test.ts'],'auxiliaryRoots':['test/release-']}
if task_id == 'C7-L':regression = {'framework':'jest','patterns':['packages/listr2/tests/*.e2e-spec.ts','packages/listr2/tests/*.spec.ts'],'auxiliaryRoots':['packages/listr2/tests/']}
if task_id == 'C7-O':regression = {'framework':'bun','patterns':['tests/*.test.ts'],'auxiliaryRoots':['tests/']}
semantic = {'T03':['C4:owner-copy-hook'],'T07':['C4:owner-route-hook'],'T11':['C4:owner-choiceObserver'],'T19':['C5:owner-onLoadResult']}.get(task_id, [])
value = {'taskId':task_id,'state':'development-not-admitted','policy':{'protectedPaths':sorted(set(protected)),'allowedPaths':allowed,'generatedPaths':generated,'jsonChanges':json_changes,'semanticProtection':semantic},'regression':regression,'readme':readme if not task_id.startswith('C7-') else None,'example':example,'criticalPrefixes':profile.get('criticalPrefixes',{}),'manualReviewRequired':['public clause coverage','actual side effects for every suspected H','user production semantics','README and example validity','reported checks versus trace'],'qualificationProfileSha256':hashlib.sha256((task/'qualification-profile.json').read_bytes()).hexdigest()}
audits = sorted(task.glob('qualification-audit-*.json'))
value['baselineQualification'] = json.loads(audits[-1].read_text())['referenceQualification'] if audits else ('qualification-1' if task_id.startswith('C7-') else None)
# 源码配置或未知辅助文件不会因扩展名而被默认放行。
save(task / 'grading-profile.json', value)
print(json.dumps({'task':task_id,'protected':len(protected),'state':value['state']}))
