"""给三款产品同一组代理事件，用各自原生记录校准准入与拒绝。"""
from datetime import datetime, timezone
import json
from pathlib import Path
import sys

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'eval/release-r3'))
from recovery_health import correlate


def clock(second):
    return datetime.fromtimestamp(second, timezone.utc).isoformat()


def fixture(product, fault):
    body = {'model':'mock','messages':[{'role':'user','content':'verify'}], 'max_tokens':100,'stream':True}
    wire, native = [], []
    def emit(k, n, sec, **data):
        wire.append({'time':clock(sec),'kind':k,'data':{'sequence':n,**data}})
    if fault != 'clean':
        emit('request',1,10,path='/v1/messages',round=1,body=body)
        emit('response_headers',1,11,status=429 if fault=='http' else 200)
        if fault=='sse':
            emit('api_error',1,12,normalizedError={'retryable':True,'errorType':'rate_limit_error'})
    n=1 if fault=='clean' else 2
    emit('request',n,20,path='/v1/messages',round=1,body=body)
    emit('response_headers',n,21,status=200)
    emit('complete_response',n,22,content=[])
    for i in range(1,n+1):
        if product!='claude':
            key={'callId':'one','attempt':i-1}
            native.extend([{'kind':'request','data':{**key,'body':body}},
                           {'kind':'response' if i==n else 'request_error','data':key}])
        else:
            native.append({'type':'api-request','id':str(i),'base':str(i-1) if i>1 else None,
                           'keep':1 if i>1 else 0,'tail':[],'requestDigest':'same-request','shapeHash':'shape',
                           'sessionId':'session','querySource':'sdk','timestamp':clock(19 if i==n else 9)})
    if product=='claude':
        native.append({'type':'assistant','requestRef':str(n),'message':{'content':[]}})
    return wire,native


def run():
    rows = []
    for product in ('v0','v1','claude'):
        for fault in ('clean','http','sse'):
            wire,native=fixture(product,fault)
            proof=correlate(wire,native,product!='claude',23)
            assert proof['status']==('clean' if fault=='clean' else 'recovered-rate-limit')
            rows.append({'product':product,'case':fault,'status':proof['status']})
        for case in ('different-body','no-completion','late','duplicate-write','wrong-logical-id','failed-aux','partial-tool','other-error'):
            wire,native=fixture(product,'sse')
            if case=='different-body':wire[3]['data']['body']={**wire[3]['data']['body'],'messages':[]}
            if case=='no-completion':wire.pop()
            if case=='duplicate-write':
                for _ in range(2):
                    native.append({'kind':'tool_result','data':{'tool_use_id':'write'}} if product!='claude'
                                  else {'type':'user','timestamp':clock(22),'message':{'content':[{'type':'tool_result','tool_use_id':'write'}]}})
            if case=='wrong-logical-id':
                if product=='claude':native[1]['base']='another'
                else:
                    for e in native[-2:]:e['data']['callId']='another'
            if case=='failed-aux':wire.extend([{'time':clock(23),'kind':'request','data':{'sequence':3,'path':'/v1/messages/count_tokens'}},
                                                {'time':clock(23),'kind':'response_headers','data':{'sequence':3,'status':503}}])
            if case=='partial-tool':wire.insert(2,{'time':clock(11),'kind':'sse','data':{'type':'content_block_start','content_block':{'type':'tool_use','id':'write'}}})
            if case=='other-error':wire[2]['data']['normalizedError']['errorType']='overloaded_error'
            try:correlate(wire,native,product!='claude',21 if case=='late' else 23)
            except ValueError as error:rows.append({'product':product,'case':case,'status':'rejected','reason':str(error)})
            else:raise AssertionError((case,product))
    return rows


if __name__=='__main__':
    rows=run()
    with Path(sys.argv[1]).open('x') as out:json.dump({'qualified':True,'rows':rows},out,ensure_ascii=False,indent=2);out.write('\n')
    print(len(rows), 'checks passed')
