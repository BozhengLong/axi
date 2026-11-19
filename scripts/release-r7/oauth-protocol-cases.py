"""校准上游过期恢复判定。通过与拒绝均须有相应的原生和代理记录。"""
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import sys

suite = Path(__file__).resolve().parents[1] / 'release-r5/protocol-cases.py'
spec = importlib.util.spec_from_file_location('rate_limit_cases', suite)
previous = importlib.util.module_from_spec(spec)
spec.loader.exec_module(previous)


def recover(product, transport):
    wire, native = previous.fixture(product, 'sse')
    wire[-1]['data']['model'] = 'mock'
    wire[2]['data']['normalizedError'] = {
        'retryable': True,
        'errorType': 'upstream_oauth_expired',
        'rule': 'gateway-upstream-oauth-expired-v1',
        'transport': transport,
    }
    if transport == 'http':
        wire[1]['data']['status'] = 401
    return wire, native


def run():
    rows = []
    for product in ('v0', 'v1', 'claude'):
        axi = product != 'claude'
        for transport in ('http', 'sse'):
            wire, native = recover(product, transport)
            proof = previous.correlate(wire, native, axi, 23, allow_oauth=True)
            assert proof['status'] == 'recovered-upstream-oauth' and proof['oauthAttempts'] == [1]
            assert proof['rateLimits'] == 0 and proof['responses'] == 1
            rows.append({'product': product, 'case': transport, 'status': proof['status']})

        for case in ('prior-policy', 'bare401', 'invalid-key', '403', 'no-completion',
                     'partial-text', 'partial-tool', 'different-body', 'wrong-model',
                     'duplicate-effect', 'other-logical-call', 'stream-fallback', 'late', 'client-aborted'):
            wire, native = recover(product, 'sse')
            if case == 'bare401':
                wire[1]['data']['status'] = 401
                wire.pop(2)
            elif case == 'invalid-key':
                wire[1]['data']['status'] = 401
                wire[2]['data']['normalizedError']['errorType'] = 'authentication_error'
            elif case == '403':
                wire[1]['data']['status'] = 403
            elif case == 'no-completion':
                wire.pop()
            elif case in ('partial-text', 'partial-tool'):
                block = {'type': 'text', 'text': 'started'} if case == 'partial-text' else {'type': 'tool_use', 'id': 'write'}
                wire.insert(2, {'time': previous.clock(11), 'kind': 'sse',
                                'data': {'type': 'content_block_start', 'content_block': block}})
            elif case in ('different-body', 'stream-fallback'):
                wire[3]['data']['body'] = deepcopy(wire[3]['data']['body'])
                if case == 'stream-fallback':
                    wire[3]['data']['body'].update(stream=False, max_tokens=50)
                else:
                    wire[3]['data']['body']['messages'] = []
            elif case == 'wrong-model':
                wire[-1]['data']['model'] = 'other'
            elif case == 'duplicate-effect':
                duplicate = {'type': 'tool_result', 'tool_use_id': 'write'}
                for _ in range(2):
                    native.append({'kind': 'tool_result', 'data': duplicate} if axi else {
                        'type': 'user', 'timestamp': previous.clock(22), 'message': {'content': [duplicate]},
                    })
            elif case == 'other-logical-call':
                if axi:
                    for event in native[-2:]:
                        event['data']['callId'] = 'another'
                else:
                    native[1]['base'] = 'another'
            elif case == 'client-aborted':
                wire.insert(2, {'time': previous.clock(11), 'kind': 'stream_error',
                                'data': {'sequence': 1, 'clientAborted': True}})
            try:
                previous.correlate(wire, native, axi, 21 if case == 'late' else 23,
                                   allow_oauth=case != 'prior-policy')
            except ValueError as error:
                rows.append({'product': product, 'case': case, 'status': 'rejected', 'reason': str(error)})
            else:
                raise AssertionError((product, case))

    return rows


if __name__ == '__main__':
    rows = previous.run() + run()
    with Path(sys.argv[1]).open('x') as out:
        json.dump({'qualified': True, 'oauthVerified': True, 'rows': rows}, out, ensure_ascii=False, indent=2)
        out.write('\n')
    print(len(rows), 'checks passed')
