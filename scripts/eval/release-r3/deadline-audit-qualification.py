"""校准到期时未转发的尝试；鉴权、缺记录和资源停止均不能冒充外部故障。"""
from pathlib import Path
import importlib.util,json,sys,hashlib,re

spec=importlib.util.spec_from_file_location('evidence_fixtures',Path(__file__).with_name('evidence-qualification.py'))
fx=importlib.util.module_from_spec(spec);spec.loader.exec_module(fx)
study=Path(sys.argv[1]).resolve();label=sys.argv[2];assert re.fullmatch(r'deadline-audit-qualification-\d+',label)
out=study/label;out.mkdir();source=Path(json.loads((study/'deadline-diagnostic-1/sealed.json').read_text())['run'])
cases={'auth':'未发送尝试缺少','missing':'已准入请求缺少','reason':'未发送尝试缺少','early':'截止事件仍有剩余窗口','different-retry':'重试改变请求快照','resource':None}
rows=[]
for repeat in range(1,6):
    positive=fx.audit_module.audit(source,True)
    assert positive['termination']=='deadline' and positive['externalTerminalCause']['status']==429 and len(positive['nativeUnforwarded'])==1
    rows.append({'case':'positive','repeat':repeat,'passed':True})
    for name,expected in cases.items():
        run=fx.clone(source,out/(name+'-'+str(repeat)));relay=run.parent/'relay'/(run.name+'.chunks')
        if name in ('auth','different-retry'):
            path=next((run/'native/axi-session').glob('*.jsonl'));data=list(fx.events(path))
            if name=='auth':next(e for e in reversed(data) if e['kind']=='request_error')['data']['reason']='HTTP 401：authentication failed'
            else:next(e for e in reversed(data) if e['kind']=='request')['data']['body']['system']='different body'
            path.write_text(''.join(json.dumps(e,ensure_ascii=False)+'\n' for e in data))
        elif name=='missing':fx.rewrite(relay,lambda r:[e for e in r if e['kind']!='request_not_forwarded'])
        elif name=='reason':fx.rewrite(relay,lambda r:fx.modify_first(r,'request_not_forwarded',lambda e:e['data'].update(reason='ordinary-failure')))
        elif name=='early':fx.rewrite(relay,lambda r:fx.modify_first(r,'execution_deadline',lambda e:e['data'].update(remainingMs=1)))
        else:
            path=run/'guardian-result.json';g=json.loads(path.read_text());g['reason']='resource';g['stop']['reason']='resource';fx.save(path,g)
        fx.reseal(run)
        try:
            result=fx.audit_module.audit(run,True)
            assert expected is None,(name,'错误证据被接受')
            assert result['termination']=='resource_interrupted' and result['externalTerminalCause'] is None
        except ValueError as error:
            assert expected and expected in str(error),(name,str(error))
        rows.append({'case':name,'repeat':repeat,'passed':True})
        fx.save(out/'results.json',{'qualified':len(rows)==35,'checks':len(rows),'rows':rows})
files=['execution-evidence.py','trace_io.py','evidence-qualification.py','deadline-audit-qualification.py']
fx.save(out/'source.json',{n:hashlib.sha256(Path(__file__).with_name(n).read_bytes()).hexdigest() for n in files})
print(json.dumps({'qualified':True,'checks':len(rows)}))
