"""从已验封的代理和原生 Trace 核对健康探针中的上游重试。"""
from collections import Counter
from datetime import datetime
from hashlib import sha256
import json
from trace_io import events


def timestamp(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def body_hash(body):
    return sha256(json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def decision(run, checked, deadline, allow_oauth=False):
    """checked 必须来自同一运行的执行审计。普通任务不调用此入口。"""
    if checked['status'] != 'completed':
        return {'status': 'not-completed', 'traceHash': checked['traceHash']}
    if (checked['termination'] != 'completed' or timestamp(checked['ioFinish']) > deadline
            or checked['externalTerminalCause'] or checked['transportErrors'] or checked['observerErrors']
            or checked['blockedGeneration'] or checked['nativeUnforwarded']):
        return {'status': 'unresolved', 'traceHash': checked['traceHash']}
    paths = [run/'native'/x['path'] for x in json.loads((run/'native/manifest.json').read_text())['files']
             if x['path'].endswith('.jsonl') and x['path'].split('/')[0] in ('axi-session', 'claude-session')]
    if len(paths) != 1:
        return {'status': 'unresolved', 'reason': '原生会话无法唯一定位', 'traceHash': checked['traceHash']}
    try:
        result = correlate(events(run.parent/'relay'/(run.name+'.jsonl')), events(paths[0]),
                           'axi-session' in paths[0].parts, deadline, allow_oauth=allow_oauth)
        if (result['rateLimits'] + result.get('oauthExpirations', 0) != checked['externalEvents']
                or result['generations'] != checked['forwardedGeneration']
                or result['responses'] != checked['completeResponses']):
            raise ValueError('回执与独立计量不符')
    except (ValueError, KeyError, TypeError, IndexError) as err:
        result = {'status': 'unresolved', 'reason': str(err)}
    return {**result, 'traceHash': checked['traceHash']}


def correlate(wire, native, axi, deadline, allow_oauth=False):
    requests = {}
    token_counts = set()
    issued, permitted = [], []
    active = None
    pending = []
    chains = []
    wait = 0
    oauth_attempts = set()
    for event in wire:
        kind, data = event['kind'], event['data']
        seq = data.get('sequence')
        if kind == 'request':
            if data['path'] == '/v1/messages/count_tokens':
                token_counts.add(seq)
                continue
            if data['path'] != '/v1/messages':
                raise ValueError('未知代理请求路径')
            if active is not None or seq in requests:
                raise ValueError('生成请求重叠或重复')
            t = timestamp(event['time'])
            body = data['body']
            digest = body_hash(body)
            semantics = body_hash({k:v for k,v in body.items() if k not in ('stream','max_tokens')})
            fallback = False
            if pending:
                previous = requests[pending[-1]]
                # 非流式回退可降低单次输出上限。消息、工具、模型及推理参数必须逐字相同。
                # 下面还须用原生 base、keep、tail 与 requestRef 证明完整继承了同一轮输入。
                fallback = (not axi and not (set(pending) & oauth_attempts) and previous['http'] == 200 and previous['stream'] is True
                            and body.get('stream') is False and semantics == previous['semantics']
                            and type(body.get('max_tokens')) is int and type(previous['tokens']) is int
                            and 0 < body['max_tokens'] <= previous['tokens'])
                if (data['round'] != previous['round'] or t < previous['end']
                        or (digest != previous['body'] and not fallback)):
                    raise ValueError('重试没有对应到同一请求')
                wait += t - previous['end']
            active = seq
            requests[seq] = {'body': digest, 'round': data['round'], 'start': t, 'tools': [], 'contentBegan': False, 'model': body.get('model'),
                             'semantics': semantics, 'stream': body.get('stream'), 'tokens': body.get('max_tokens'),
                             'fallback': fallback, 'messages': len(body.get('messages', []))}
        elif kind == 'response_headers':
            status = data['status']
            if seq not in requests:
                if 200 <= status < 300 and seq in token_counts:
                    continue
                raise ValueError('响应头缺少相应生成请求，或辅助请求失败')
            if seq != active or 'http' in requests[seq]:
                raise ValueError('响应头无法绑定')
            requests[seq]['http'] = status
            if status == 429:
                requests[seq].update(limit=True, end=timestamp(event['time']))
                pending.append(seq)
                active = None
            elif not (200 <= status < 300 or (allow_oauth and status == 401)):
                raise ValueError('出现非限流HTTP错误')
        elif kind == 'sse' and data.get('type') == 'content_block_start':
            if active is None:
                raise ValueError('内容块缺少请求')
            requests[active]['contentBegan'] = True
            block = data['content_block']
            if block.get('type') == 'tool_use':
                requests[active]['tools'].append(block['id'])
        elif kind == 'api_error':
            err = data['normalizedError']
            if seq != active or seq not in requests or err.get('retryable') is not True:
                raise ValueError('错误事件缺少唯一的可重试请求')
            current = requests[seq]
            is_oauth = (allow_oauth and err.get('errorType') == 'upstream_oauth_expired'
                        and err.get('rule') == 'gateway-upstream-oauth-expired-v1'
                        and ((err.get('transport') == 'http' and current.get('http') == 401)
                             or (err.get('transport') == 'sse' and current.get('http') == 200))
                        and not current['contentBegan'])
            is_limit = (err.get('errorType') == 'rate_limit_error'
                        and 200 <= current.get('http', 0) < 300 and not current['tools'])
            if not (is_oauth or is_limit):
                raise ValueError('上游错误归因失败或失败流已交付内容')
            if is_oauth:
                oauth_attempts.add(seq)
            requests[seq].update(limit=True, end=timestamp(event['time']))
            pending.append(seq)
            active = None
        elif kind == 'permission':
            if pending and (active is None or data['toolUseId'] not in requests[active]['tools']):
                raise ValueError('限流重试期间发生无法绑定的工具授权')
            permitted.append(data['toolUseId'])
        elif kind == 'complete_response':
            if seq != active or not 200 <= requests[seq].get('http', 0) < 300:
                raise ValueError('完整响应缺少对应的成功请求')
            if allow_oauth and data.get('model') != requests[seq]['model']:
                raise ValueError('完整响应模型改变')
            t = timestamp(event['time'])
            if t > deadline or t < requests[seq]['start']:raise ValueError('完整响应超出执行窗口')
            tools = [b['id'] for b in data['content'] if b.get('type') == 'tool_use']
            if data.get('transport') != 'json' and tools != requests[seq]['tools']:raise ValueError('工具提案与完整响应不符')
            issued.extend(tools)
            requests[seq]['end'] = t
            if pending:chains.append({'limited': pending, 'completed': seq})
            pending = []
            active = None
        elif kind in ('observer_parse_error','model_mismatch','upstream_error','stream_error',
                      'request_not_forwarded','request_blocked','execution_deadline','sse_tail','truncated'):
            raise ValueError('存在未解决的传输、观察或截止事件')
    if not requests or pending or active is not None:
        raise ValueError('生成请求缺少最终完整响应')

    calls = []
    native_replies, native_errors = set(), set()
    starts, results, claude_refs = [], [], set()
    user_times = []
    for event in native:
        if axi:
            k, d = event['kind'], event['data']
            if k == 'request':calls.append((d['callId'], d['attempt'], body_hash(d['body'])))
            elif k in ('response','request_error'):
                key = (d['callId'], d['attempt'])
                seen = native_replies if k == 'response' else native_errors
                if key in seen:raise ValueError('原生终态重复')
                seen.add(key)
            elif k == 'tool_start':starts.append(d['toolUseId'])
            elif k == 'tool_result':results.append(d['tool_use_id'])
        else:
            if event.get('type') == 'api-request':
                calls.append(event)
            elif event.get('type') == 'user':
                user_times.append(timestamp(event['timestamp']))
            if event.get('type') not in ('user','assistant'):continue
            blocks = event.get('message',{}).get('content',[])
            if not isinstance(blocks,list):continue
            if event['type']=='assistant' and event.get('requestRef'):
                claude_refs.add(event['requestRef'])
            for block in blocks:
                if block.get('type') == 'tool_result':results.append(block['tool_use_id'])
                elif block.get('type') == 'tool_use':starts.append(block['id'])
    if (len(set(issued)) != len(issued) or Counter(results) != Counter(issued)
            or (starts and Counter(starts) != Counter(issued))
            or len(set(permitted)) != len(permitted) or not set(permitted)<=set(issued)):
        raise ValueError('工具执行、回执或授权有缺失或重复')
    if axi:
        if [call[2] for call in calls] != [r['body'] for r in requests.values()]:
            raise ValueError('原生请求与代理不符')
        by_seq = dict(zip(requests,calls))
        failed = {call[:2] for seq, call in by_seq.items() if requests[seq].get('limit')}
        succeeded = {call[:2] for seq, call in by_seq.items() if not requests[seq].get('limit')}
        if failed != native_errors or succeeded != native_replies or failed & succeeded:
            raise ValueError('原生终态与代理不符')
        for chain in chains:
            keys = [by_seq[n][:2] for n in [*chain['limited'],chain['completed']]]
            if len({k[0] for k in keys}) != 1 or [k[1] for k in keys] != list(range(len(keys))):
                raise ValueError('完整响应属于另一逻辑调用')
    else:
        # Claude 每次物理尝试各写一条 api-request。base 本身只表示前序记录。
        # 它必须同时绑定空增量、完整消息前缀、同一会话和对应完整响应的 requestRef。
        if len(calls) != len(requests) or len({c['id'] for c in calls}) != len(calls):
            raise ValueError('Claude 尝试与代理请求无法一一对应')
        by_seq = dict(zip(requests, calls))
        expected = {by_seq[seq]['id'] for seq, request in requests.items() if not request.get('limit')}
        if expected != claude_refs:
            raise ValueError('Claude 完整响应与原生 requestRef 不符')
        previous_end = None
        for seq, call in by_seq.items():
            began = timestamp(call['timestamp'])
            if (previous_end is not None and began < previous_end) or began > requests[seq]['start']:
                raise ValueError('Claude 原生尝试超出相应请求边界')
            previous_end = requests[seq]['end']
        for chain in chains:
            seqs = [*chain['limited'], chain['completed']]
            for prior, retry in zip(seqs, seqs[1:]):
                before, after = by_seq[prior], by_seq[retry]
                start = timestamp(before['timestamp'])
                end = timestamp(after['timestamp'])
                if (after.get('base') != before['id'] or after.get('tail') != []
                        or after.get('keep') != requests[prior]['messages']
                        or after.get('sessionId') != before['sessionId']
                        or after.get('querySource') != before['querySource']
                        or after.get('shapeHash') != before['shapeHash']
                        or any(start < entered <= end for entered in user_times)):
                    raise ValueError('Claude 重试未完整继承同一调用')
                if requests[retry]['fallback']:
                    if any(call['params']['max_tokens'] != requests[n]['tokens']
                           for n, call in ((prior,before),(retry,after))):
                        raise ValueError('Claude 原生回退的输出上限与代理不符')
                elif not before.get('requestDigest') or before['requestDigest'] != after.get('requestDigest'):
                    raise ValueError('Claude 重试的原生请求摘要改变')
    limits=sum(len(c['limited']) for c in chains)
    result = {'status':'recovered-rate-limit' if chains else 'clean','generations':len(requests),
              'responses':len(requests)-limits,'rateLimits':limits-len(oauth_attempts),'chains':chains,
              'observedRetryGapMs':round(wait*1000)}
    if oauth_attempts:
        result.update(status='recovered-upstream-oauth', oauthExpirations=len(oauth_attempts),
                      oauthAttempts=sorted(oauth_attempts))
    return result
