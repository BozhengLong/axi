"""用本地模拟上游驱动三款真实 CLI，保留每个场景的初次尝试。"""
import json
import os
from pathlib import Path
import subprocess
import sys

R3 = Path(__file__).resolve().parents[1] / 'eval/release-r3'


def main(study, revision):
    assert revision.isalnum()
    out = study / ('health-matrix-' + revision)
    out.mkdir()
    read = lambda path: json.loads(path.read_text())
    env = {**os.environ, **read(study / 'toolchain/verification.json')['env'],
           'PYTHONDONTWRITEBYTECODE': '1', 'ANTHROPIC_API_KEY': 'synthetic-local-key',
           'ANTHROPIC_BASE_URL': 'http://127.0.0.1:1',
           'AXI_EVAL_IMAGE': read(study / 'health/qualification-profile.json')['image']}
    rows = []
    for fault in ('clean', 'http429', 'sse429'):
        for product in ('v0', 'v1', 'claude'):
            tag = revision + '-' + fault
            name = product + '-' + fault
            command = ['bun', str(R3 / 'pipeline-one.ts'), str(study), 'health', product, tag]
            if fault != 'clean':
                command.append(fault)
            with (out / (name + '.stdout')).open('xb') as stdout, (out / (name + '.stderr')).open('xb') as stderr:
                run = subprocess.run(command, env=env, stdout=stdout, stderr=stderr)
            row = {'product': product, 'fault': fault, 'exit': run.returncode, 'qualified': False}
            if run.returncode == 0:
                label = 'health-' + product + '-' + tag
                path = study / 'controller-integration' / label / 'controller-events.jsonl'
                state = json.loads(path.read_text().splitlines()[-1])['state']
                claim = state['claims']['health-' + product + '-a1']
                review = claim['review']
                proof = review['recoveryHealth']
                completed = claim['seal']['termination'] == 'completed'
                expected = ('clean' if fault == 'clean' else 'recovered-rate-limit') if completed else 'not-completed'
                qualified = (proof['status'] == expected and proof['traceHash'] == claim['seal']['traceHash']
                             and (completed or fault != 'clean')
                             and review['classification'] == ('PASS' if completed else 'ENV_INTERRUPTED'))
                row.update(qualified=qualified, decision=proof, classification=review['classification'],
                           traceDirectory=read(study/'health'/('pipeline-'+product+'-'+tag)/'result.json')['traceDirectory'])
            rows.append(row)
            print(name, row['qualified'], row.get('decision', {}).get('status'), flush=True)
    qualified = all(row['qualified'] for row in rows)
    for fault in ('http429', 'sse429'):
        qualified &= any(r['fault'] == fault and r.get('decision', {}).get('status') == 'recovered-rate-limit' for r in rows)
    (out/'result.json').write_text(json.dumps({'qualified': qualified, 'mockOnly': True, 'rows': rows}, indent=2)+'\n')
    return 0 if qualified else 1


if __name__ == '__main__':
    sys.exit(main(Path(sys.argv[1]).resolve(), sys.argv[2]))
