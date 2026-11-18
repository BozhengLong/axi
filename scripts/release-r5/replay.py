"""只读回放 C4 账本。反例只在内存中修改，不重开旧批次。"""
import copy
import json
from pathlib import Path
import runpy
import sys

R3 = Path(__file__).resolve().parents[1] / 'eval/release-r3'
sys.path.insert(0, str(R3))
from controller import RECOVERY_POLICY, Refused, new_state, next_slot, recovery_probe_passed, transition
from recovery_health import correlate, decision
from trace_io import events, sha


def read(path):
    return json.loads(path.read_text())


def replay(old):
    audit = runpy.run_path(str(R3/'execution-evidence.py'))['audit']
    gateway = runpy.run_path(str(R3/'controller-gateway.py'))
    closed, last_hash = gateway['read_state'](old/'formal-controller')
    assert closed['closure']['verdict'] == 'INCOMPLETE'
    ledger = old/'formal-controller/controller-events.jsonl'
    before = sha(ledger)
    rows = list(events(ledger))
    proofs = {}
    grades = {}
    for key, claim in closed['claims'].items():
        path = old/'runs'/key
        run = Path(read(path/'execution-result.json')['traceDirectory'])
        actual = audit(run)
        assert actual == read(path/'execution-evidence.json') == claim['seal']['executionEvidence']
        assert sha(path/'final-grade/result.json') == claim['review']['gradeHash']
        assert sha(path/'review.json') == claim['review']['reviewEvidenceHash']
        proofs[key] = decision(run, actual, claim['executionDeadline'])
        grades[key] = claim['review']['classification']
    assert list(grades.values()) == ['ENV_INTERRUPTED', 'PASS', 'PASS']
    assert [p['status'] for p in proofs.values()] == ['not-completed','clean','recovered-rate-limit']
    assert proofs['recovery-1-health-v1-a1']['chains'] == [
        {'limited':[1,2], 'completed':3}, {'limited':[4,5], 'completed':6}]
    # 用相同操作和历史时钟重算所有转移。旧规则逐项比对已封存状态。
    old_state = changed = None
    for event in rows:
        action, payload, now = event['action'], event['payload'], event['at']
        if action == 'initialize':
            old_state = new_state(payload['authorization'], payload['identities'])
            changed = new_state({**payload['authorization'], 'recoveryHealthPolicy':RECOVERY_POLICY},payload['identities'])
        else:
            old_state = transition(old_state, action, payload, now)
            if action == 'close':
                assert old_state == event['state']
                break
            modified = payload
            if action == 'freeze':
                modified = {**payload, 'recoveryHealthPolicy':RECOVERY_POLICY}
            if action == 'claim':
                modified = {**payload, 'manifestHash':gateway['digest'](changed['manifest'])}
            if action == 'review':
                modified = {**payload, 'recoveryHealth':proofs[payload['id']]}
            changed = transition(changed, action, modified, now)
        assert old_state == event['state']
    assert changed['activeRecovery'] == 0 and next_slot(changed, now)['id'] == 'recovery-1-health-claude-a1'
    next_id = next_slot(changed, now)['id']
    claim_payload = next(r['payload'] for r in reversed(rows) if r['action']=='claim')
    try:
        transition(changed, 'claim', {**claim_payload,'manifestHash':gateway['digest'](changed['manifest']),'id':'C7-L-a1'}, now)
    except Refused as error:
        assert '顺序' in str(error)
    else:
        raise AssertionError('两方通过时放行了C7')
    good = changed['claims']['recovery-1-health-v1-a1']
    refused = []
    for key, value in [('classification',v) for v in ('N','H','UNKNOWN','ENV_INTERRUPTED')]+[
        ('recoveryHealth',{}),('recoveryHealth',{'status':'clean','traceHash':'other'})]:
        sample = {**good, 'review':{**good['review'],key:value}}
        assert not recovery_probe_passed(changed, sample)
        refused.append(str(value))
    assert sha(ledger) == before
    return {'ledgerSha256':before, 'lastEventHash':last_hash, 'historicalVerdict':closed['closure']['verdict'],
            'replayOnlyNextSlot':next_id, 'twoOfThreeBlocksC7':True, 'historicalReviews':grades,
            'proofs':proofs, 'rejectedReviews':refused}


def counterexamples(old):
    path = old/'runs/recovery-1-health-v1-a1'
    run = Path(read(path/'execution-result.json')['traceDirectory'])
    native_path = next(p for p in (run/'native/axi-session').glob('*.jsonl'))
    wire = list(events(run.parent/'relay'/(run.name+'.jsonl')))
    native = list(events(native_path))
    def unrelated(rows):
        for event in rows:
            if event['kind']=='request' and event['data']['sequence']==3:
                event['data']['body']['unrelated']=True
    def new_call(rows):
        for event in rows:
            d=event['data']
            if d.get('attempt')==2 and d.get('callId'):
                d['callId']='different-logical-call'
    def mixed(rows):
        next(x for x in rows if x['kind']=='api_error')['data']['normalizedError']['errorType']='overloaded_error'
    def duplicate(rows):
        rows.append(next(x for x in rows if x['kind']=='tool_result'))
    def auth(rows):
        next(x for x in rows if x['kind']=='response_headers')['data']['status']=401
    complete = lambda rows: rows.__setitem__(slice(None), [r for r in rows if not(r['kind']=='complete_response' and r['data']['sequence']==3)])
    cases = [('missing-response',complete,None),('other-request',unrelated,None),('other-logical-call',None,new_call),
             ('duplicate-tool-result',None,duplicate),('mixed-error',mixed,None),('auth-error',auth,None),
             ('late-response',None,None)]
    results = []
    for name, change_wire, change_native in cases:
        w,n=copy.deepcopy(wire),copy.deepcopy(native)
        if change_wire:change_wire(w)
        if change_native:change_native(n)
        try:correlate(w,n,True,0 if name=='late-response' else float('inf'))
        except ValueError as err:results.append({'case':name,'reason':str(err)})
        else:raise AssertionError('反例未被拒绝 '+name)
    return results


if __name__=='__main__':
    old, output = map(Path, sys.argv[1:3])
    proof = {'qualified':True, 'replay':replay(old), 'counterexamples':counterexamples(old), 'newFormalStarts':0}
    with output.open('x') as f:json.dump(proof,f,ensure_ascii=False,indent=2);f.write('\n')
    print(proof['replay']['replayOnlyNextSlot'],len(proof['counterexamples']))
