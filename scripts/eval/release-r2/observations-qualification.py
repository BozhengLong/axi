"""用已封存的原生正例/反例校准归一化读取器。只读重解释，不冒充新测试执行。"""
from pathlib import Path
import hashlib,json,sys
sys.dont_write_bytecode=True
from observations import observe
study=Path(sys.argv[1]).resolve();revision=sys.argv[2];assert revision.isalnum();out=study/('observations-qualification-'+revision);out.mkdir();rows=[]
for n in ['observations.py','bun-report.py',Path(__file__).name]:(out/n).write_bytes(Path(__file__).with_name(n).read_bytes())
folders=[('node','node-reporter-qualification'),('vitest','vitest-reporter-qualification'),('tap','tap-reporter-qualification'),('mocha','mocha-reporter-qualification-async-2'),('jest','jest-reporter-qualification-3'),('bun','bun-observer-qualification-linux-1')]
for framework,folder in folders:
 root=study/folder;result=json.loads((root/'results.json').read_text());assert result['qualified']
 for prior in result['rows']:
  name=prior.get('id',f"{prior.get('case',prior.get('name'))}-{prior['repeat']}");label=name.rsplit('-',1)[0];case=root/name
  if framework in ['node','vitest']:
   code=prior.get('code',prior.get('exitCode'));wanted_assertion=prior['assertion'];wanted_pass=label=='pass'
  elif framework=='bun':
   code=prior['exit'];wanted_assertion=bool(prior['expectedOrigins'])and all(prior['expectedOrigins']);wanted_pass=code==0 and label!='skip'
  else:
   wanted_pass=prior['expectedSuccess'];wanted_assertion=prior.get('behaviorAssertion',False)
   if framework=='tap':
    code=json.loads((case/'native.json').read_text())['code']if(case/'native.json').exists()else 1
   else:code=0 if label in ['pass','skip','todo','empty']else 1
  paths=[case/'stdout',case/'native.json',case/'native.xml',case/'assertions.jsonl'];hashes={str(p):hashlib.sha256(p.read_bytes()).hexdigest()for p in paths if p.exists()}
  try:
   value=observe(framework,case/'stdout',case/'native.json',code,case/'native.xml',case/'assertions.jsonl');actual_pass=bool(value['passed']and not value['skips']);actual_assertion=value['behaviorFailure'];problems=value['problems']
  except(ValueError,KeyError,OSError)as error:actual_pass=actual_assertion=False;problems=[str(error)]
  passed=actual_pass==wanted_pass and actual_assertion==wanted_assertion
  row={'framework':framework,'case':name,'passed':passed,'success':actual_pass,'expectedSuccess':wanted_pass,'behaviorAssertion':actual_assertion,'expectedAssertion':wanted_assertion,'problems':problems,'evidenceHashes':hashes};rows.append(row)
(out/'results.json').write_text(json.dumps({'qualified':all(r['passed']for r in rows),'offlineReinterpretation':True,'cases':len(rows),'rows':rows},ensure_ascii=False,indent=2)+'\n')
failed=[r for r in rows if not r['passed']];print(json.dumps({'cases':len(rows),'failed':failed},ensure_ascii=False));assert not failed
