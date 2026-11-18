"""逐项核对 C4 尚未启动代表题，继承已封存的素材暴露记录。"""
from pathlib import Path
import json
import runpy
import sys

R3=Path(__file__).resolve().parents[1]/'eval/release-r3'
sys.path.insert(0,str(R3))
from trace_io import sha


def read(p):
    return json.loads(p.read_text())


def main(old, fresh):
    gateway=runpy.run_path(str(R3/'controller-gateway.py'))
    state,chain = gateway['read_state'](old/'formal-controller')
    manifest = state['manifest']
    assert state['closure']['verdict']=='INCOMPLETE'
    assert read(old/'release-manifest.json') == manifest
    assert manifest['identities']['candidate']==read(fresh/'candidate.json')['candidate']
    assert list(state['claims']) == ['health-v0-a1','health-v0-a2','recovery-1-health-v1-a1']
    reuse=read(gateway['bound_file'](old,manifest['proofs']['reuse']))
    path=gateway['bound_file'](old,reuse['exposure'])
    prior=read(path)
    assert prior['qualified'] and prior['candidate']==manifest['identities']['candidate']
    assert len(reuse['rows'])==22
    materials=read(fresh/'material-source-audit.json')
    by_id={r['task']:r for r in materials['tasks']}
    for row in reuse['rows']:
        assert by_id[row['id']]['oldAuditSha256']==row['priorAuditHash']
    out=fresh/'exposure-audit-c4';out.mkdir()
    proof={'qualified':True,'candidate':prior['candidate'],'currentPriorClaims':list(state['claims']),
           'previousLedgerHash':chain,'priorExposure':{'path':str(path),'sha256':sha(path)},
           'materials':sha(fresh/'material-source-audit.json'),'priorMaterialsMatched':len(by_id),
           'representativeFormalStartsInC4':0,'modelStartsInThisAudit':0}
    with (out/'result.json').open('x') as f:json.dump(proof,f,ensure_ascii=False,indent=2);f.write('\n')


if __name__=='__main__':main(*(Path(v).resolve() for v in sys.argv[1:3]))
