"""归一化原生测试证据。加载失败不冒充行为断言，既有skip按身份比较。"""
from pathlib import Path
import importlib.util
import json
from collections import Counter

_spec = importlib.util.spec_from_file_location('bun_report', Path(__file__).with_name('bun-report.py'))
_bun = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_bun)


def observe(framework, stdout, native, code, xml=None, assertions=None):
    rows, problems = [], []
    def row(file, name, state, assertion=False):
        rows.append({'file': file or '', 'name': name, 'state': state, 'assertion': bool(assertion)})
    if framework == 'node':
        marker = '# AXI_TEST_ASSERTIONS_V1 '
        found = [line[len(marker):] for line in Path(stdout).read_text().splitlines() if line.startswith(marker)]
        if len(found) != 1:
            raise ValueError('缺少唯一Node原生报告')
        data = json.loads(found[0]); totals = [s['counts'] for s in data['summaries'] if not s.get('file')]
        if len(totals) != 1:
            raise ValueError('Node聚合报告不唯一')
        failures = {(f.get('file'), f['name']): f for f in data['failures']}
        for case in data['cases']:
            if case.get('type') == 'suite':
                continue
            failure = failures.get((case.get('file'), case['name']), {})
            state = 'skip' if case.get('skip') else 'todo' if case.get('todo') else 'pass' if case['event'] == 'test:pass' else 'fail'
            row(case.get('file'), case['name'], state, failure.get('assertion') and failure.get('failureType') == 'testCodeFailure')
        if totals[0]['cancelled']:
            problems.append('cancelled')
        if len(rows) != totals[0]['tests']:
            problems.append('test-count-mismatch')
    elif framework == 'vitest':
        data = json.loads(Path(native).read_text())
        problems += ['unhandled'] if data['unhandled'] else []
        problems += ['suite-load-error'] if any(s['errors'] for s in data['suites']) else []
        for case in data['tests']:
            row(case['file'], case['name'], case['state'], bool(case['errors']) and all(e['assertion'] for e in case['errors']))
    elif framework == 'jest':
        data = json.loads(Path(native).read_text())
        if data['interrupted'] or data['counts']['numRuntimeErrorTestSuites']:
            problems.append('interrupted-or-load-error')
        for suite in data['suites']:
            if suite['execError']:
                problems.append('suite-load-error')
            for case in suite['tests']:
                state = {'passed': 'pass', 'failed': 'fail', 'pending': 'skip'}.get(case['status'], case['status'])
                row(suite['file'], case['name'], state, bool(case['errors']) and all(e['assertion'] for e in case['errors']))
        if len(rows) != data['counts']['numTotalTests']:
            problems.append('test-count-mismatch')
    elif framework == 'mocha':
        data = json.loads(Path(native).read_text())
        failures = {(f.get('file'), f['name']): f for f in data['failures']}
        if any(f['hook'] for f in data['failures']):
            problems.append('hook-error')
        for case in data['tests']:
            state = 'skip' if case.get('pending') else {'passed': 'pass', 'failed': 'fail'}.get(case.get('state'), case.get('state'))
            row(case.get('file'), case['name'], state, failures.get((case.get('file'), case['name']), {}).get('error', {}).get('assertion', False))
        if len(rows) != data['stats']['tests']:
            problems.append('test-count-mismatch')
    elif framework == 'tap':
        data = json.loads(Path(native).read_text())
        if data['parserErrors'] or data.get('signal') or data.get('launchError') or not data.get('root'):
            problems.append('parser-or-process-error')
        if not data.get('root', {}).get('ok') or any(not suite['result']['ok'] or suite['result']['bailout'] for suite in data['suites']):
            problems.append('tap-aggregate-failure')
        if data.get('code') != code:
            problems.append('tap-exit-mismatch')
        for case in data['points']:
            if not case['closing']:
                row('', case['name'], 'skip' if case['skip'] else 'todo' if case['todo'] else 'pass' if case['ok'] else 'fail')
            if case['tapError']:
                problems.append('tap-error')
        # TAP原输出未证明失败来源；此格式只验证原基线。新增回归用Node断言来源。
    elif framework == 'bun':
        data = _bun.parse(xml, assertions, code)
        if not data['trustworthy']:
            raise ValueError(data['error'])
        for case in data['observations']:
            row(case.get('file'), case['name'], 'pass' if case['passed'] else 'fail', case.get('assertionFailure'))
        for case in data['skipIds']:
            row(case['file'], case['name'], 'skip')
    else:
        raise ValueError('未知原生框架')
    if code not in (0, 1):
        problems.append('process-exit')
    failed = [r for r in rows if r['state'] == 'fail']
    skips = [r for r in rows if r['state'] == 'skip']
    if any(r['state'] not in ('pass', 'fail', 'skip') for r in rows):
        problems.append('unfinished-or-todo')
    if (code == 0) != (len(failed) == 0):
        problems.append('exit-test-mismatch')
    return {'framework': framework, 'rows': rows, 'problems': sorted(set(problems)), 'tests': len(rows),
            'passed': code == 0 and bool(rows) and not problems and not failed,
            'behaviorFailure': code == 1 and bool(failed) and not problems and all(r['assertion'] for r in failed),
            'skips': skips, 'failed': failed}


def retained_baseline(before, after):
    """保留全部旧测试的成功/跳过身份；新测试可以增加，不能替代旧测试。"""
    identity = lambda r: (r['file'], r['name'], r['state'])
    old = Counter(identity(r) for r in before['rows'])
    current = Counter(identity(r) for r in after['rows'])
    skip = lambda report: Counter(identity(r) for r in report['skips'])
    return bool(before['passed'] and after['passed'] and not (old - current) and skip(before) == skip(after))


def regression_valid(before, after):
    return bool(before['behaviorFailure'] and after['passed'] and before['tests'] > 0
                and before['tests'] == after['tests'] and not before['skips'] and not after['skips'])
