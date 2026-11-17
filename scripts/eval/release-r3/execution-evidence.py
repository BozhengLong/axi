"""R3执行审计：请求计量与环境归因分开，完整Trace不等于任务通过。"""
from pathlib import Path
import json
import sys
from trace_io import events, sha, verify_run


def audit(run, mock=False, expected_model='claude-opus-5-5', expected_effort='medium'):
    run = Path(run).resolve();manifest = verify_run(run)
    execution = json.loads((run/'execution.json').read_text())
    io_start = io_end = None
    for event in events(run/'io.jsonl'):
        if event['kind'] == 'start':
            if io_start:raise ValueError('重复CLI启动')
            io_start = event
        if event['kind'] == 'finish':
            if io_end:raise ValueError('重复CLI结束')
            io_end = event
        if event['kind'] in ('truncated','stderr_read_error'):
            raise ValueError('IO证据缺失')
    if not io_start or not io_end or io_end['data']['status'] != execution['status']:
        raise ValueError('CLI生命周期或终态不符')
    registered = closed = 0
    admitted = generation = count_tokens = complete = permissions = 0
    last_sequence = 0;last_generation = 0;last_complete = 0;last_kind = '';last_stop = None
    blocked_generation = blocked_count_tokens = transport_errors = 0
    admitted_ids=set();request_ids=set();complete_ids=set()
    external = {};local_interruption = set();model_errors = [];request_hashes = []
    for event in events(run.parent/'relay'/(run.name+'.jsonl')):
        kind, data = event['kind'], event['data'];last_kind = kind
        if kind == 'registered':
            registered += 1
            if data['id'] != run.name or data['mock'] is not mock or data['executionPolicy']['limitMode'] != 'unlimited' or data['executionPolicy']['requestLimit'] is not None:
                raise ValueError('模拟身份或不限次数策略不符')
        elif kind == 'writer_closed':closed += 1
        elif kind == 'request_admitted':
            if data['sequence'] <= last_sequence:raise ValueError('请求序号倒序或重复')
            last_sequence = data['sequence'];admitted += 1;admitted_ids.add(data['sequence'])
        elif kind == 'request_blocked':
            if data['reason'] not in ('deadline','revoked'):raise ValueError('存在未授权请求截断')
            if data['path'].endswith('count_tokens'):blocked_count_tokens += 1
            else:blocked_generation += 1
        elif kind == 'request':
            if data['sequence'] not in admitted_ids or data['sequence'] in request_ids:raise ValueError('请求没有唯一准入记录')
            request_ids.add(data['sequence'])
            if data['path'] == '/v1/messages':
                generation += 1;last_generation = data['sequence']
                if data['body'].get('model') != expected_model or data['body'].get('output_config',{}).get('effort') != expected_effort:
                    raise ValueError('请求模型/档位不符')
                # 只保留摘要用于与原生请求对应，不保留所有大请求体。
                import hashlib
                request_hashes.append(hashlib.sha256(json.dumps(data['body'],sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest())
            elif data['path'] == '/v1/messages/count_tokens':count_tokens += 1
            else:raise ValueError('请求路径不符')
        elif kind == 'response_headers' and (data['status'] == 429 or data['status'] >= 500):
            external[data['sequence']] = {'kind':'upstream-http','status':data['status']}
        elif kind == 'api_error':
            normalized = data['normalizedError']
            if normalized.get('retryable') is True:
                external[data['sequence']] = {'kind':'upstream-sse','normalized':normalized}
        elif kind == 'upstream_error':
            transport_errors+=1
            # 原始HTTP/SSE见证以外的断连暂不自动确认为外部；避免把代理自身错误算上游。
            if data.get('localDeadline') or data.get('revoked') or data.get('clientAborted') or not data.get('forwarded'):local_interruption.add(data['sequence'])
        elif kind in ('stream_error','request_not_forwarded'):
            transport_errors+=1
            if data.get('localDeadline') or data.get('revoked') or data.get('clientAborted') or kind == 'request_not_forwarded':local_interruption.add(data['sequence'])
        elif kind == 'complete_response':
            if data['sequence'] not in request_ids or data['sequence'] in complete_ids:raise ValueError('响应没有唯一请求记录')
            complete_ids.add(data['sequence'])
            if data['model'] != expected_model:raise ValueError('实际响应型号不符')
            complete += 1;last_complete = data['sequence'];last_stop=data.get('stopReason')
        elif kind == 'permission':permissions += 1
        elif kind in ('observer_parse_error','model_mismatch'):model_errors.append(data)
        elif kind in ('truncated','budget_exhausted'):raise ValueError('证据截断或旧预算仍生效')
    if registered != 1 or closed != 1 or last_kind != 'writer_closed':raise ValueError('代理证据生命周期不完整')
    final_states=json.loads((run.parent/'relay-before-close.json').read_text())['states']
    selected=[x for x in final_states if x['id']==run.name]
    if len(selected)!=1 or not selected[0]['closed'] or selected[0]['activeRequests']!=0:raise ValueError('最终代理状态没有绑定运行')
    final_state=selected[0]
    meter = final_state['meter']
    if meter['limitMode'] != 'unlimited' or meter['requestLimit'] is not None:raise ValueError('代理计量策略不符')
    if generation > meter['forwardedGeneration'] or count_tokens > meter['forwardedCountTokens'] or admitted != meter['forwardedGeneration']+meter['forwardedCountTokens']:
        raise ValueError('代理准入与请求计数不符')
    if complete != final_state['responseCount'] or permissions != final_state['permissionCount'] or complete > generation:
        raise ValueError('完整响应/授权计数不符')
    if blocked_generation != meter['blockedGeneration'] or blocked_count_tokens != meter['blockedCountTokens']:
        raise ValueError('阻止请求的计数不符')
    if execution['status']=='completed' and (last_complete!=last_generation or last_stop not in ('end_turn','stop_sequence')):raise ValueError('完成声明没有对应完整最终响应')
    if io_start['data']['agent']=='claude' and execution['status']=='completed':
        results=[e for e in events(run/'claude.jsonl') if e.get('type')=='result']
        if len(results)!=1 or results[0].get('is_error') or results[0].get('subtype')!='success':raise ValueError('Claude没有正常完成记录')
    native = json.loads((run/'native/manifest.json').read_text())
    if native['status'] != 'collected':raise ValueError('原生日志未收齐')
    native_names=set()
    for item in native['files']:
        path=run/'native'/item['path']
        if item['path'] in native_names or path.is_symlink() or not path.resolve().is_relative_to(run/'native') or not path.is_file() or path.stat().st_size!=item['bytes'] or sha(path)!=item['sha256']:raise ValueError('原生日志文件身份或字节不符')
        native_names.add(item['path'])
    native_requests = [];ends = [];reviews = 0;native_keys=[];native_key_set=set();native_errors={};cancelled=False;windows=set();native_unforwarded=[]
    session=None;turn_requests=0;work_requests=0;review_requests=0
    if io_start['data']['agent'] == 'axi':
        paths = [run/'native'/f['path'] for f in native['files'] if f['path'].startswith('axi-session/') and f['path'].endswith('.jsonl')]
        if len(paths) != 1:raise ValueError('Axi原生会话不唯一')
        import hashlib
        for event in events(paths[0]):
            if session is None:session=event.get('sessionId')
            if not session or event.get('sessionId')!=session:raise ValueError('原生会话身份漂移')
            if event['kind']=='task_start':turn_requests=work_requests=review_requests=0
            if event['kind']=='request':
                key=(event['data']['callId'],event['data']['attempt'])
                if key in native_key_set:raise ValueError('原生请求尝试重复')
                native_key_set.add(key)
                turn_requests+=1
                if event.get('version')==4:
                    b=event['data'].get('budget',{});phase=b.get('phase')
                    if phase=='work':work_requests+=1
                    elif phase=='review':review_requests+=1
                    else:raise ValueError('原生阶段无效')
                    if b.get('unlimited') is not True or b.get('remaining') is not None or (b.get('requests'),b.get('workRequests'),b.get('reviewRequests'))!=(turn_requests,work_requests,review_requests):raise ValueError('原生不限次数计量不连续')
                native_requests.append(hashlib.sha256(json.dumps(event['data']['body'],sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest());native_keys.append((event['data']['callId'],event['data']['attempt']))
            if event['kind']=='request_error':native_errors[(event['data']['callId'],event['data']['attempt'])]=event['data'].get('reason','')[:500]
            if event['kind']=='cancel_requested':cancelled=True
            if event['kind']=='retry_exhausted':windows.add(event['data']['callId'])
            if event['kind']=='task_end':
                if event.get('version')==4:
                    b=event['data'].get('budget',{})
                    if (b.get('requests'),b.get('workRequests'),b.get('reviewRequests'))!=(turn_requests,work_requests,review_requests):raise ValueError('原生终态计数不符')
                ends.append(event['data'])
            if event['kind']=='review_start':reviews+=1
        if native_requests != request_hashes:
            if execution['status']=='completed' or native_requests[:len(request_hashes)]!=request_hashes or len(native_requests)<=len(request_hashes):raise ValueError('原生尝试与代理请求不完全对应，需单独核对未发送原因')
            for key in native_keys[len(request_hashes):]:
                reason=native_errors.get(key,'')
                if not ((cancelled and ('中止' in reason or 'abort' in reason.lower())) or (key[0] in windows and '恢复窗口' in reason)):raise ValueError('未发送尝试缺少取消/窗口截止见证')
                native_unforwarded.append({'callId':key[0],'attempt':key[1],'reason':reason})
        if execution['status']=='completed' and (len(ends)!=1 or ends[0].get('outcome','completed')!='completed'):raise ValueError('正常结束缺少原生证明')
        if reviews>1:raise ValueError('同一任务超过一次复核')
    cause = external.get(last_generation) if last_generation > last_complete and last_generation not in local_interruption else None
    return dict(schema=3,mockOnly=mock,traceHash=sha(run/'trace-manifest.json'),executionHash=sha(run/'execution.json'),files=len(manifest['files']),
                receivedAttempts=meter['receivedGeneration']+meter['receivedCountTokens'],receivedGeneration=meter['receivedGeneration'],
                forwardedGeneration=generation,countTokens=count_tokens,completeResponses=complete,permissions=permissions,
                blockedGeneration=blocked_generation,status=execution['status'],ioStart=io_start['time'],ioFinish=io_end['time'],
                nativeEnds=ends,nativeUnforwarded=native_unforwarded,reviewCheckpoints=reviews,externalEvents=len(external),externalTerminalCause=cause,
                observerErrors=model_errors,transportErrors=transport_errors,trustworthyObservableTrace=True,
                forwardingDefinition='request记录表示请求体通过准入；不推断上游一定接收或完成。')


if __name__=='__main__':
    print(json.dumps(audit(sys.argv[1],mock='--mock' in sys.argv[2:]),ensure_ascii=False))
