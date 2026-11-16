"""离线读取Bun原生JUnit；按预先冻结的选择器核对实际行为用例，不按根tests总数判分。"""
from pathlib import Path
import sys,json,re,xml.etree.ElementTree as ET
root=Path(sys.argv[1]); plan=json.loads((root/'plan.json').read_text()); data=json.loads((root/'results.json').read_text())
expected={(v['id'],n):v for v in plan['variants'] for n in range(1,6)}
assert len(data['rows'])==len(expected)
seen=set(); audited=[]
for row in data['rows']:
 key=(row['id'],row['repeat']); assert key in expected and key not in seen; seen.add(key); variant=expected[key]
 for role in ['positive','negative']:
  path=root/row['id']/f"{role}-{row['repeat']}.xml"; tree=ET.parse(path); cases=tree.findall('.//testcase')
  selected=[c for c in cases if re.search(variant['pattern'],c.attrib['name'])]
  executed=[c for c in cases if c.find('skipped') is None]
  assert len(selected)==len(executed)==1 and selected[0] is executed[0],(key,role)
  assert not tree.findall('.//error'); failures=executed[0].findall('failure')
  command=row[role]; assert not command['timeout']; assert command['code']==(0 if role=='positive' else 1)
  assert len(failures)==(0 if role=='positive' else 1)
  if failures: assert failures[0].attrib.get('type')=='AssertionError'
  assert int(executed[0].attrib['assertions'])>0
  audited.append({'id':row['id'],'repeat':row['repeat'],'role':role,'test':executed[0].attrib['name'],'executed':1,'filtered':len(cases)-1,'failures':len(failures),'exitCode':command['code']})
assert seen==set(expected)
out={'qualified':True,'variants':len(plan['variants']),'pairs':len(expected),'processes':len(audited),'rows':audited,'note':'filtered是运行前选择器未选的用例，不计通过；完整候选测试另跑，必须无skip/todo。'}
(root/'assertion-audit.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n');print(json.dumps({k:v for k,v in out.items() if k!='rows'},ensure_ascii=False))
