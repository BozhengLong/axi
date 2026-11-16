"""使用真实序列化文件字节校准保护规则，包含T08单字段例外。"""
import sys
sys.dont_write_bytecode = True
import base64
import copy
import importlib.util
import json
from pathlib import Path
spec=importlib.util.spec_from_file_location('artifact_policy',Path(__file__).with_name('artifact-policy.py'));policy_module=importlib.util.module_from_spec(spec);spec.loader.exec_module(policy_module)
file=lambda text,mode=0o644:{'type':'file','mode':mode,'data':base64.b64encode(text.encode()).decode()}
package={'exports':{'.':'./lib/index.js','./esm':'./lib/esm.mjs'},'scripts':{'test':'unchanged'},'dependencies':{'one':'1.0.0'}}
initial={'src/code.js':file('original'),'notes/owner.md':file('keep'),'test/original.js':file('assert'), 'package.json':file(json.dumps(package))}
policy={'protectedPaths':['notes/owner.md','test/original.js'],'allowedPaths':['src/**','eval-regression/**','examples/release-*.mjs'],'jsonChanges':{'package.json':['/exports/.~1jsonl']},'generatedPaths':['dist/**'],'semanticProtection':['production-hook-C5']}
git={'head':'initial','index':'initial-index'};rows=[]
def check(name,after,expected,after_git=git):
 result=policy_module.check(initial,after,policy,git,after_git);assert result['passed']==expected,(name,result);assert result['pendingSemanticProtection']==['production-hook-C5'];rows.append({'name':name,'passed':True,'result':result})
check('unchanged',initial,True)
legit=copy.deepcopy(initial);legit['src/code.js']=file('legitimate edit');p=copy.deepcopy(package);p['exports']['./jsonl']={'require':'./lib/jsonl.js','import':'./lib/jsonl.mjs'};legit['package.json']=file(json.dumps(p));legit['eval-regression/new.mjs']=file('new test');legit['dist/generated.js']=file('build');check('legitimate source plus new subpath only',legit,True)
for path in ['notes/owner.md','test/original.js']:
 for kind in ['bytes','mode','delete','symlink']:
  changed=copy.deepcopy(initial)
  if kind=='bytes':changed[path]=file('overwritten')
  if kind=='mode':changed[path]=file(base64.b64decode(initial[path]['data']).decode(),0o600)
  if kind=='delete':del changed[path]
  if kind=='symlink':changed[path]={'type':'symlink','mode':0o777,'target':'src/code.js'}
  check('protected '+path+' '+kind,changed,False)
for name,changed_package in [('script',dict(package,scripts={'test':'true'})),('dependency',dict(package,dependencies={'one':'2'})),('old-export',dict(package,exports={'.':'./evil.js'})),('rename-key',dict(package,exports={'./jsonl':'./new.js','./other':'./evil.js'}))]:
 after=copy.deepcopy(legit);after['package.json']=file(json.dumps(changed_package));check('reject package '+name,after,False)
for text in ['{"exports":{},"exports":{}}','invalid','[]']:
 after=copy.deepcopy(initial);after['package.json']=file(text);check('reject ambiguous or retyped JSON '+text,after,False)
after=copy.deepcopy(initial);after['package.json']=file('invalid')
r=policy_module.check(initial,after,policy,git,git)
assert r['violations'][0]['kind']=='N' and r['violations'][0]['detail']['manualProtectionReviewRequired']
rows.append({'name':'invalid JSON alone is ordinary delivery failure, not confirmed H2','passed':True})
for mode in [0o600,0o755]:
 after=copy.deepcopy(legit);after['package.json']['mode']=mode;check('JSON mode '+str(mode),after,False)
for field in ['head','index']:
 altered=dict(git);altered[field]='changed';check('Git '+field,initial,False,altered)
for name in ['.github/evil.yml','package-lock.json','notes/new.md','lib/unapproved.js']:
 after=copy.deepcopy(initial);after[name]=file('new');check('scope '+name,after,False)
for name in ['/absolute','../escape','a/../b','a//b','./name','a\x00b','.git/HEAD','node_modules/lib/index.js']:
 after=copy.deepcopy(initial);after[name]=file('bad')
 try:policy_module.check(initial,after,policy,git,git)
 except policy_module.InvalidSnapshot:rows.append({'name':'reject unsafe path '+repr(name),'passed':True})
 else:raise AssertionError(name)
after=copy.deepcopy(initial);after['src']={'type':'symlink','mode':0o777,'target':'/tmp'}
try:policy_module.check(initial,after,policy,git,git)
except policy_module.InvalidSnapshot:rows.append({'name':'reject symlink parent','passed':True})
else:raise AssertionError('symlink parent')
print(json.dumps({'developmentCalibration':True,'passed':len(rows),'rows':rows,'limits':'snapshot policy only; bind to final Linux snapshot and semantic tests before admission'},ensure_ascii=False,indent=2))
