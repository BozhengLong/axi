"""重算校验和后的语义反例；检出不能仅依赖文件哈希改变。"""
from pathlib import Path
import importlib.util,json,hashlib,shutil,sys
from trace_io import events,sha

spec=importlib.util.spec_from_file_location('r3_evidence',Path(__file__).with_name('execution-evidence.py'));audit_module=importlib.util.module_from_spec(spec);spec.loader.exec_module(audit_module)

def save(path,data):path.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
def rewrite(directory,change):
    rows=list(events(directory));rows=change(rows);shutil.rmtree(directory);directory.mkdir()
    raw=b''.join((json.dumps(e,ensure_ascii=False,separators=(',',':'))+'\n').encode() for e in rows)
    (directory/'00000000.bin').write_bytes(raw)
    save(directory/'manifest.json',{'schema':1,'status':'closed','bytes':len(raw),'chunks':[{'name':'00000000.bin','bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}]})

def clone(source,dest):
    run=dest/source.name;dest.mkdir();shutil.copytree(source,run);(dest/'relay').mkdir()
    shutil.copytree(source.parent/'relay'/(source.name+'.chunks'),dest/'relay'/(source.name+'.chunks'))
    for name in ('relay-before-close.json','relay-closed.json','sealed-traces.json'):shutil.copyfile(source.parent/name,dest/name)
    return run

def reseal(run):
    native=run/'native/manifest.json';data=json.loads(native.read_text())
    for f in data['files']:p=run/'native'/f['path'];f.update(bytes=p.stat().st_size,sha256=sha(p))
    save(native,data)
    path=run/'trace-manifest.json';data=json.loads(path.read_text())
    for f in data['files']:p=run/f['path'];f.update(bytes=p.stat().st_size,sha256=sha(p))
    save(path,data)
    seals=run.parent/'sealed-traces.json';data=json.loads(seals.read_text())
    for f in data['seals']:
        if f['id']==run.name:f['manifestHash']=sha(path)
    save(seals,data)

def modify_first(rows,kind,edit):
    for e in rows:
        if e.get('kind')==kind:edit(e);break
    else:raise ValueError('负例源缺少目标事件')
    return rows

study=Path(sys.argv[1]).resolve();out=study/sys.argv[2];out.mkdir()
source=Path(json.loads((study/'runtime-qualification-2/http40-http50.json').read_text())['traceDirectory'])
claude_batch=json.loads((study/'c3-adapter-cli-1/batch.json').read_text());claude=Path(claude_batch['directory'])/'claude-allow-1'
cases=[('request-cap','模拟身份或不限次数策略不符'),('missing-request','响应没有唯一请求记录'),('duplicate-response','响应没有唯一请求记录'),('wrong-model','请求模型/档位不符'),('native-count','原生不限次数计量不连续'),('native-terminal','正常结束缺少原生证明'),('writer-missing','代理证据生命周期不完整'),('io-missing','CLI生命周期或终态不符'),('claude-is-error','Claude没有正常完成记录')]
rows=[]
for name,expected in cases:
    run=clone(claude if name.startswith('claude') else source,out/name);audit_module.audit(run,True)
    relay=run.parent/'relay'/(run.name+'.chunks')
    if name=='request-cap':rewrite(relay,lambda r:modify_first(r,'registered',lambda e:e['data']['executionPolicy'].update(requestLimit=50)))
    elif name=='missing-request':
        def remove(r):
            i=next(i for i,e in enumerate(r) if e['kind']=='request');return r[:i]+r[i+1:]
        rewrite(relay,remove)
    elif name=='duplicate-response':
        def duplicate(r):
            i=next(i for i,e in enumerate(r) if e['kind']=='complete_response');return r[:i]+[r[i]]+r[i:]
        rewrite(relay,duplicate)
    elif name=='wrong-model':rewrite(relay,lambda r:modify_first(r,'request',lambda e:e['data']['body'].update(model='wrong-model')))
    elif name.startswith('native-'):
        path=next((run/'native/axi-session').glob('*.jsonl'));data=list(events(path))
        if name=='native-count':modify_first(data,'request',lambda e:e['data']['budget'].update(requests=50))
        else:modify_first(data,'task_end',lambda e:e['data'].update(outcome='retry_exhausted'))
        path.write_text(''.join(json.dumps(e,ensure_ascii=False)+'\n' for e in data))
    elif name=='writer-missing':rewrite(relay,lambda r:[e for e in r if e['kind']!='writer_closed'])
    elif name=='io-missing':rewrite(run/'io.chunks',lambda r:[e for e in r if e['kind']!='finish'])
    else:
        path=run/'claude.jsonl';data=list(events(path));result=next(e for e in data if e.get('type')=='result');result['is_error']=True;path.write_text(''.join(json.dumps(e,ensure_ascii=False)+'\n' for e in data))
    reseal(run)
    try:audit_module.audit(run,True)
    except ValueError as e:
        assert expected in str(e),(name,str(e));rows.append({'case':name,'rejectedFor':str(e),'hashesRecomputed':True})
    else:raise AssertionError('错误证据被接受: '+name)
    save(out/'results.json',{'qualified':len(rows)==len(cases),'rows':rows})
print(json.dumps({'qualified':True,'cases':len(rows)},ensure_ascii=False))
