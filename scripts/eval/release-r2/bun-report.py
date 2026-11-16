"""交叉核对Bun JUnit和原生调用观察记录，不信任JUnit的failure type字段。"""
import json
import xml.etree.ElementTree as ET
from pathlib import Path


def parse(xml_path, observer_path, exit_code):
    try:
        raw = Path(xml_path).read_text()
        if '<!DOCTYPE' in raw or '<!ENTITY' in raw:
            raise ValueError('报告包含未允许的DTD')
        root = ET.fromstring(raw)
        if root.tag != 'testsuites':
            raise ValueError('报告根错误')
        cases = root.findall('./testsuite/testcase')
        failures = [c for c in cases if c.find('failure') is not None or c.find('error') is not None]
        skipped = [c for c in cases if c.find('skipped') is not None]
        for key, actual in [('tests', len(cases)), ('failures', len(failures)), ('skipped', len(skipped))]:
            if int(root.attrib[key]) != actual:
                raise ValueError('JUnit聚合与逐项数量不符')
        for suite in root.findall('./testsuite'):
            children = suite.findall('./testcase')
            if int(suite.attrib['tests']) != len(children):
                raise ValueError('JUnit suite计数不符')
        data = Path(observer_path).read_bytes()
        if not data.endswith(b'\n'):
            raise ValueError('观察记录末行不完整')
        events = [json.loads(line) for line in data.splitlines()]
        starts = [e for e in events if e['kind'] == 'test-start']
        ends = [e for e in events if e['kind'] == 'test-end']
        boot = [e for e in events if e['kind'] == 'observer-start']
        if len(boot) != 1 or boot[0]['bun'] != '1.3.14':
            raise ValueError('观察器启动身份不符')
        if len({e['id'] for e in starts}) != len(starts) or len({e['id'] for e in ends}) != len(ends):
            raise ValueError('重复测试身份')
        if {e['id'] for e in starts} != {e['id'] for e in ends} or len(ends) != len(cases) - len(skipped):
            raise ValueError('测试体观察不完整')
        failed = [e for e in ends if not e['passed']]
        if len(failed) != len(failures):
            raise ValueError('原生测试失败与观察记录不符，可能有hook或加载故障')
        if exit_code not in (0, 1) or (exit_code == 0) != (not failures):
            raise ValueError('进程退出与测试结果不符')
        return {'trustworthy': True, 'tests': len(cases), 'failed': len(failures), 'skipped': len(skipped),
                'passed': len(cases) - len(failures) - len(skipped),
                'assertionFailures': sum(bool(e['assertionFailure']) for e in failed),
                'allFailuresAreAssertions': bool(failed) and all(e['assertionFailure'] for e in failed),
                'skipIds': [{'file': c.attrib.get('file'), 'name': c.attrib.get('name')} for c in skipped],
                'observations': ends}
    except (ValueError, KeyError, OSError, ET.ParseError) as error:
        return {'trustworthy': False, 'error': str(error)}


def regression_valid(before, after):
    return bool(before.get('trustworthy') and after.get('trustworthy') and after['tests'] > 0
                and before['tests'] == after['tests'] and before['skipped'] == after['skipped'] == 0
                and after['failed'] == 0 and before['allFailuresAreAssertions'])
