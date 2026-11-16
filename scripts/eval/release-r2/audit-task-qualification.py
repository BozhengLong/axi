"""核对逐题参考/负例证据，不把这一层审计升级为全部题包准入。"""
from pathlib import Path
import datetime
import hashlib
import json
import re
import sys

study = Path(sys.argv[1]).resolve()
task_id, positive_revision, negative_revision, audit_revision = sys.argv[2:6]
assert re.fullmatch(r'T\d\d', task_id)
assert all(re.fullmatch(r'[A-Za-z0-9_-]+', x) for x in (positive_revision, negative_revision, audit_revision))
task = study / 'tasks' / task_id
profile = json.loads((task / 'qualification-profile.json').read_text())
controls = json.loads((task / 'negative-controls.json').read_text())
positive = task / ('qualification-' + positive_revision)
negative = task / ('negative-qualification-' + negative_revision)
assert controls.get('positiveQualification', 'qualification-2') == positive.name
p = json.loads((positive / 'results.json').read_text())
n = json.loads((negative / 'results.json').read_text())
assert p['qualified'] and p['facilityStable'] and n['qualified'] and n['facilityStable']
assert len(p['rows']) == (len(profile['references']) + 2) * 5
assert len(n['rows']) == len(controls['controls']) * 5
for directory in (positive, negative):
    for source, checksum in json.loads((directory / 'facility.json').read_text()).items():
        assert hashlib.sha256((directory / 'facility-source' / checksum).read_bytes()).hexdigest() == checksum
        source_path = Path(source)
        if source_path.is_relative_to(task):
            assert hashlib.sha256(source_path.read_bytes()).hexdigest() == checksum, '已校准的任务输入后来改变'
by_id = {c['id']: c for c in controls['controls']}
assert len(by_id) == len(controls['controls'])
seen = set()
for row in n['rows']:
    key = (row['id'], row['repeat'])
    assert key not in seen and row['repeat'] in range(1, 6) and row['qualified']
    seen.add(key)
    control = by_id[row['id']]
    for prefix in control.get('forbiddenPrefixes', []):
        assert not any(name.startswith(prefix + ':') for name in row.get('failedNames', [])), '普通拒绝/异常被错误计为关键违约: ' + row['id']
assert seen == {(c['id'], repeat) for c in controls['controls'] for repeat in range(1, 6)}
roles = ['initial', *profile['references'], 'counterfactual']
assert {(r['role'], r['repeat']) for r in p['rows']} == {(role, repeat) for role in roles for repeat in range(1, 6)}
assert all(r['passed'] and r['elapsedSeconds'] <= 720 for r in p['rows'])
result = {'taskId': task_id, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'referenceQualification': positive.name, 'negativeQualification': negative.name,
          'sourceArchivesVerified': True, 'taskInputsUnchanged': True,
          'negativeClassificationChecked': True, 'referenceCases': len(p['rows']),
          'negativeCases': len(n['rows']), 'maxReferenceSeconds': max(r['elapsedSeconds'] for r in p['rows']),
          'admitted': False, 'remaining': ['three actual CLI/fake API pipelines', 'final package scoring/controller qualification'],
          'realModelStarts': 0}
out = task / ('qualification-audit-' + audit_revision + '.json')
with out.open('x') as output:
    json.dump(result, output, ensure_ascii=False, indent=2)
    output.write('\n')
print(json.dumps(result))
