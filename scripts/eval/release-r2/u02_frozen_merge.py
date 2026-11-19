"""U02 冻结合并缺陷的回归资格。通用观察结果保留原样。"""
import hashlib
import json
import re
import subprocess

POLICY = 'u02-frozen-merge-v28'
INPUT_SHA256 = '2f650d03941623adb4dc140fa29ab776076847b6c6f3fefa2ea28734ce85ab79'
MERGE_SHA256 = '4cc67378cb5c51833d06af944a583f5ca3e4b58e56f8930ffea9e93c0a4f20b5'

# 独立用例直接执行固定的旧源码。候选测试与该用例不共享代码。
_REPRODUCE = """
import { mergeAll } from './src/merge.ts';
const frozen = Object.freeze([1, 2]);
const other = [3];
let failure;
try { mergeAll([{a: frozen}, {a: other}], {mergeArrays: true}); }
catch (error) { failure = {name: error.name, message: error.message, stack: error.stack}; }
const normal = mergeAll([{a: [1, 2]}, {a: other}], {mergeArrays: true});
if (!failure || frozen.join() !== '1,2' || other.join() !== '3' || normal.a.join() !== '1,2,3') {
  throw Error('冻结与可写对照不符合预期');
}
console.log(JSON.stringify(failure));
"""


def reproduction(task, timeout):
    manifest = task / 'input-manifest.json'
    original = task / 'initial/src/merge.ts'
    if hashlib.sha256(manifest.read_bytes()).hexdigest() != INPUT_SHA256:
        raise ValueError('U02 输入清单与冻结缺陷不匹配')
    if hashlib.sha256(original.read_bytes()).hexdigest() != MERGE_SHA256:
        raise ValueError('U02 旧合并源码与冻结缺陷不匹配')
    process = subprocess.run(['node', '--input-type=module', '-e', _REPRODUCE], cwd=original.parent.parent,
                             check=True, capture_output=True, text=True, timeout=timeout)
    failure = json.loads(process.stdout)
    if not merge_failure(failure, original.resolve().as_uri()):
        raise ValueError('独立用例未进入冻结的旧合并路径')
    return {'sourceSha256': MERGE_SHA256, 'inputSha256': INPUT_SHA256,
            'outcome': 'old-merge-frozen-array-push', 'witness': failure}


def merge_failure(error, source):
    stack = error.get('stack', '').splitlines()
    return (error.get('name') == 'TypeError'
            and re.fullmatch(r'Cannot add property \d+, object is not extensible', error.get('message', ''))
            and len(stack) >= 3
            and stack[1].strip() == 'at Array.push (<anonymous>)'
            and stack[2].strip() == f'at merge ({source}:29:23)')


def assess(before, after, old_native, new_native):
    def cases(raw):
        return {(r['id'], r['file'], r['name']): r for r in raw['tests']}

    def import_merge(error):
        if not merge_failure(error, '/task/src/merge.ts'):
            return False
        frames = error['stack'].splitlines()[3:]
        return (any('at Module.mergeAll (/task/src/merge.ts:52:18)' in line for line in frames)
                and any(re.fullmatch(
                    r'\s*at Explorer(?:Sync)?\.#loadConfigFileWithImports \(/task/src/Explorer(?:Sync)?\.ts:\d+:\d+\)',
                    line) for line in frames))

    old = cases(old_native)
    new = cases(new_native)
    missing = (not after['passed'] or before['problems'] or before['skips'] or after['skips']
               or not old or len(old) != before['tests'] or len(new) != after['tests']
               or old.keys() != new.keys())
    result = {'policy': POLICY, 'passed': False, 'assertionFailures': [],
              'pendingCompanionExceptions': [], 'unqualifiedFailures': []}
    if missing:
        return {**result, 'reason': 'execution-or-test-identity'}
    for (test_id, test_file, name), row in old.items():
        if row['state'] == 'pass':
            continue
        witness = {'id': test_id, 'file': test_file, 'name': name}
        errors = row['errors']
        if errors and all(e['assertion'] is True for e in errors):
            result['assertionFailures'].append(witness)
        elif errors and all(e['assertion'] is False and import_merge(e) for e in errors):
            result['pendingCompanionExceptions'].append(witness)
        else:
            result['unqualifiedFailures'].append(witness)
    return result


def qualify(evidence, independent=None):
    """每组须可解释，至少一组有真实断言。伴随异常须有独立复现。"""
    permitted = {'sourceSha256': MERGE_SHA256, 'inputSha256': INPUT_SHA256,
                 'outcome': 'old-merge-frozen-array-push'}
    for group in evidence:
        companions = group.pop('pendingCompanionExceptions')
        supported = not companions or (independent is not None and
                                       all(independent.get(k) == v for k, v in permitted.items()))
        group['companionExceptions'] = companions if supported else []
        if not supported:
            group['unqualifiedFailures'].extend(companions)
        group['passed'] = not group.get('reason') and not group['unqualifiedFailures']
    passed = bool(evidence and all(g['passed'] for g in evidence)
                  and any(g['assertionFailures'] for g in evidence))
    return {'policy': POLICY, 'passed': passed, 'groups': evidence, 'independent': independent}
