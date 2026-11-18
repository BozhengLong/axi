"""核对真实领取记录、模拟归档和本次产品改动的任务来源。"""
from pathlib import Path
import hashlib
import json
import subprocess
import sys


def read(path):
    return json.loads(path.read_text())


def sha(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f,'sha256').hexdigest()


def main(old, study, experiment):
    materials=read(study/'material-source-audit.json')
    assert materials['formalClaims']==['health-v0-a1','health-v1-a1','health-claude-a1','C7-L-a1','C7-O-a1']
    manifest=read(old/'release-manifest.json');proof=manifest['proofs']['evidenceAudit']
    assert sha(old/proof['path'])==proof['sha256']
    audit=read(old/proof['path'])
    assert audit['mockOnly'] and audit['qualified'] and audit['realModelStarts']==0
    rows=[]
    for row in audit['rows']:
        if not row['task'].startswith('U'):
            continue
        result=old/row['result']['path']
        assert sha(result)==row['result']['sha256'] and row['qualified']
        run=Path(read(result)['traceDirectory'])
        assert run.is_relative_to(old/'runtime') and sha(run/'trace-manifest.json')==row['traceHash']
        chunks=run.parent/'relay'/(run.name+'.chunks')
        first=read(chunks/'manifest.json')['chunks'][0]
        assert first['name']=='00000000.bin' and sha(chunks/first['name'])==first['sha256']
        with (chunks/first['name']).open('rb') as stream:
            registered=json.loads(stream.readline())
        assert registered['kind']=='registered' and registered['data']['mock'] is True
        rows.append({'task':row['task'],'product':row['product'],'priorResult':row['result'],
                     'traceSha256':row['traceHash'],'registrationChunkSha256':first['sha256']})
    assert {(r['task'],r['product']) for r in rows}=={(f'U{i:02}',a) for i in range(1,21) for a in ('v0','v1','claude')}
    product=read(study/'candidate.json')['product']
    research=read(experiment/'manifest.json');assert research['experiment']==product
    cases={p.stem for p in (experiment/'inputs').glob('*.json')}
    assert cases=={'history','clean','recovered','regression','latest','unobserved'}
    holdouts={p.name for p in (experiment/'holdouts').iterdir() if (p/'result.json').exists()}
    assert holdouts=={'inventory','release-label'}
    repo=Path(__file__).resolve().parents[2]
    changes=subprocess.check_output(['git','diff','--name-only',manifest['identities']['candidate'],product,'--','src','tests'],cwd=repo,text=True).splitlines()
    assert set(changes)=={'src/agent/loop.ts','src/agent/review.ts','src/tools/check-attempts.ts',
                         'src/tools/common.ts','src/tools/registry.ts','tests/check-attempts.test.ts'}
    diff=subprocess.check_output(['git','diff',manifest['identities']['candidate'],product,'--','src','tests'],cwd=repo)
    dest=study/'exposure-audit-c4';dest.mkdir()
    (dest/'product.diff').write_bytes(diff)
    result={'qualified':True,'candidate':read(study/'candidate.json')['candidate'],'priorFormalClaims':materials['formalClaims'],
            'priorLedgerHash':materials['ledgerSha256'],'priorPipelines':rows,'cases':sorted(cases),'holdouts':sorted(holdouts),
            'studyManifestHash':sha(experiment/'manifest.json'),'productPaths':changes,'productDiffHash':sha(dest/'product.diff'),
            'scope':'可核的调优输入是已知C7-L、命令历史和两道留出题。20道代表题在上一批仅作模拟，未领取真实槽。维护者可见材料；这些记录无法判断模型预训练史。'}
    (dest/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')


if __name__=='__main__':
    main(*(Path(p).resolve() for p in sys.argv[1:4]))
