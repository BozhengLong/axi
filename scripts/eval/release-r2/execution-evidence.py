"""核对封存Trace与请求口径。接收尝试、获准转发的生成请求和count_tokens分别计数。"""
from pathlib import Path,PurePosixPath
import hashlib,json


def sha(path):
    h=hashlib.sha256()
    with Path(path).open('rb')as stream:
        while data:=stream.read(1024*1024):h.update(data)
    return h.hexdigest()


def lines(path):
    raw=Path(path).read_bytes()
    if not raw or not raw.endswith(b'\n'):raise ValueError('证据JSONL缺少完整末行')
    return [json.loads(line)for line in raw.splitlines()]


def audit(run, expected_model='claude-opus-5-5', expected_effort='medium', limit=50, mock=False):
    run=Path(run).resolve();batch=run.parent
    manifest_path=run/'trace-manifest.json';manifest=json.loads(manifest_path.read_text())
    if manifest['run']!=run.name or manifest['status']!='complete_observable' or manifest['missing']:raise ValueError('Trace身份或完整状态不符')
    entries={}
    for entry in manifest['files']:
        name=entry['path'];relative=PurePosixPath(name)
        relay_name='../relay/'+run.name+'.jsonl'
        if name != relay_name and (relative.is_absolute() or '..' in relative.parts or str(relative)!=name):raise ValueError('Trace清单路径不合法')
        path=batch/'relay'/f'{run.name}.jsonl' if name==relay_name else run/name
        if name in entries or not path.is_file() or path.is_symlink():raise ValueError('Trace清单路径不合法')
        for parent in path.parents:
            if parent==batch:break
            if not parent.is_relative_to(batch) or parent.is_symlink():raise ValueError('Trace父路径不合法')
        if path.stat().st_size!=entry['bytes']or sha(path)!=entry['sha256']:raise ValueError('Trace文件改变: '+name)
        entries[name]=entry
    required=['execution.json','io.jsonl','writers-closed.json','native/manifest.json','../relay/'+run.name+'.jsonl']
    if any(name not in entries for name in required):raise ValueError('关键证据没有纳入封存清单')
    writer=json.loads((run/'writers-closed.json').read_text());closed=json.loads((batch/'relay-closed.json').read_text())
    if writer['relay']!=closed['name']or closed['exitCode']!=0 or closed['remaining']:raise ValueError('最后写入者关闭记录不符')
    sealed=json.loads((batch/'sealed-traces.json').read_text());matching=[x for x in sealed['seals']if x['id']==run.name]
    if len(matching)!=1 or matching[0]['manifestHash']!=sha(manifest_path):raise ValueError('清单没有最终封存')
    io=lines(run/'io.jsonl');relay=lines(batch/'relay'/f'{run.name}.jsonl');execution=json.loads((run/'execution.json').read_text())
    if sum(x['kind']=='start'for x in io)!=1 or sum(x['kind']=='finish'for x in io)!=1:raise ValueError('CLI生命周期记录不完整')
    if any(x['kind']=='truncated'for x in io+relay):raise ValueError('Trace超限')
    registered=[e for e in relay if e['kind']=='registered']
    if len(registered)!=1 or registered[0]['data']['mock'] is not mock:raise ValueError('模拟与真实身份不符')
    requests=[e for e in relay if e['kind']=='request'];sequence=[e['data']['sequence']for e in requests]
    if sequence!=sorted(set(sequence)):raise ValueError('请求序列重复或倒序')
    generation=[e for e in requests if e['data']['path']=='/v1/messages'];counts=[e for e in requests if e['data']['path']=='/v1/messages/count_tokens']
    if len(generation)+len(counts)!=len(requests):raise ValueError('未知请求路径')
    if any(e['data']['body'].get('model')!=expected_model or e['data']['body'].get('output_config',{}).get('effort')!=expected_effort for e in generation):raise ValueError('生成请求模型或effort不符')
    if not 0<len(generation)<=limit:raise ValueError('生成请求数量无效')
    responses=[e['data']for e in relay if e['kind']=='complete_response'];partial=[e['data']['message']['model']for e in relay if e['kind']=='sse'and e['data'].get('type')=='message_start']
    if any(x.get('model')!=expected_model for x in responses) or any(x!=expected_model for x in partial):raise ValueError('实际响应模型不符')
    budget=execution['proxy']['budget'];blocked=[e['data']for e in relay if e['kind']=='budget_exhausted']
    if budget['maxTotal']!=limit or budget['maxRounds']!=1 or budget['round']!=1:raise ValueError('冻结请求预算不符')
    if any(b['generationRequests']<=b['maxTotal'] and b['roundRequests']<=b['maxPerRound'] for b in blocked):raise ValueError('预算拦截记录没有达到边界')
    if budget['countRequests']!=len(counts)or budget['generationRequests']!=len(generation)+len(blocked)or budget['requests']!=budget['countRequests']+budget['generationRequests']:raise ValueError('请求预算与事件口径不符')
    if len(responses)>len(generation):raise ValueError('响应数多于生成请求')
    return {'traceHash':sha(manifest_path),'executionHash':sha(run/'execution.json'),'files':len(entries),
            'mockOnly':mock,'receivedAttempts':budget['requests'],'receivedGeneration':budget['generationRequests'],
            'forwardedGeneration':len(generation),'countTokens':len(counts),'blockedGeneration':len(blocked),
            'completeResponses':len(responses),'status':execution['status'],'faults':execution['proxy']['faults'],
            'transportIssues':execution['proxy']['transportIssues'],'ioStart':next(e['time']for e in io if e['kind']=='start'),
            'ioFinish':next(e['time']for e in io if e['kind']=='finish'),'trustworthyObservableTrace':True,
            'forwardingDefinition':'有效生成请求已获转发准入；不把上游接收或完成推断为已发生'}


if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser()
    parser.add_argument('run')
    parser.add_argument('--mock',action='store_true')
    parser.add_argument('--limit',type=int,default=50)
    args=parser.parse_args()
    if not 1<=args.limit<=50:raise ValueError('请求上限无效')
    print(json.dumps(audit(args.run,limit=args.limit,mock=args.mock),ensure_ascii=False))
