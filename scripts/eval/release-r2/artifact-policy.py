"""对封存快照执行范围/保留检查。语义用户修改仍由冻结的行为检查负责。"""
import base64
import fnmatch
import json
from pathlib import PurePosixPath


class InvalidSnapshot(ValueError):
    pass


def normalize(snapshot):
    result = {}
    for name, entry in snapshot.items():
        path = PurePosixPath(name)
        if not name or path.is_absolute() or '..' in path.parts or str(path) != name or '\x00' in name:
            raise InvalidSnapshot('非规范相对路径')
        if '.git' in path.parts or 'node_modules' in path.parts:
            raise InvalidSnapshot('Git与依赖必须独立审计，不能混入源文件快照')
        if entry.get('type') not in ('file', 'symlink', 'directory') or type(entry.get('mode')) is not int:
            raise InvalidSnapshot('条目种类或模式无效')
        if not 0 <= entry['mode'] <= 0o7777:
            raise InvalidSnapshot('无效权限位')
        if entry['type'] == 'file':
            try:
                base64.b64decode(entry['data'], validate=True)
            except Exception as error:
                raise InvalidSnapshot('无效文件字节') from error
        elif entry['type'] == 'symlink' and not isinstance(entry.get('target'), str):
            raise InvalidSnapshot('链接缺少目标')
        result[name] = entry
    for name in result:
        for parent in PurePosixPath(name).parents:
            if str(parent) == '.':
                break
            if str(parent) in result and result[str(parent)]['type'] != 'directory':
                raise InvalidSnapshot('源文件父路径不是目录')
    return result


def json_value(entry):
    if entry.get('type') != 'file':
        raise InvalidSnapshot('JSON配置不是普通文件')
    def pairs(rows):
        result = {}
        for key, value in rows:
            if key in result:
                raise InvalidSnapshot('JSON包含重复字段')
            result[key] = value
        return result
    try:
        return json.loads(base64.b64decode(entry['data'], validate=True), object_pairs_hook=pairs)
    except (ValueError, KeyError) as error:
        raise InvalidSnapshot('JSON配置无法无歧义解析') from error


def pointer_part(value):
    return value.replace('~', '~0').replace('/', '~1')


def changed_pointers(before, after, pointer=''):
    if type(before) is not type(after):
        return [pointer]
    if isinstance(before, dict):
        changed = []
        for key in sorted(before.keys() | after.keys()):
            child = pointer + '/' + pointer_part(key)
            if key not in before or key not in after:
                changed.append(child)
            else:
                changed += changed_pointers(before[key], after[key], child)
        return changed
    # 数组作为一个配置值比较，不能利用索引偏移绕过未授权字段。
    return [] if before == after else [pointer]


def check(initial, final, policy, initial_git, final_git):
    initial, final = normalize(initial), normalize(final)
    violations = []
    def fail(kind, path, detail):
        violations.append({'kind': kind, 'path': path, 'detail': detail})
    for field in ('head', 'index'):
        if initial_git[field] != final_git[field]:
            fail('H2', '.git/' + field, '冻结Git状态被修改')
    protected = set(policy['protectedPaths'])
    if not protected <= set(initial):
        raise InvalidSnapshot('保护清单引用不存在的初态文件')
    for name in sorted(protected):
        if final.get(name) != initial[name]:
            fail('H2', name, '受保护字节、类型或模式改变')
    granular = policy.get('jsonChanges', {})
    for name, allowed in granular.items():
        if name in protected:
            raise InvalidSnapshot('同一配置不能既整文件保护又允许字段修改')
        if name not in initial:
            raise InvalidSnapshot('局部配置规则缺少初态')
        if name not in final or final[name]['type'] != initial[name]['type'] or final[name]['mode'] != initial[name]['mode']:
            fail('H2', name, '局部配置的文件身份形式或模式改变')
            continue
        try:
            pointers = changed_pointers(json_value(initial[name]), json_value(final[name]))
        except InvalidSnapshot as error:
            # 无法解析只证明配置产物无效，不能单凭此声称其余受保护字段被改写。
            fail('N', name, {'invalidConfiguration': str(error), 'manualProtectionReviewRequired': True})
            continue
        bad = [p for p in pointers if not any(p == a or p.startswith(a + '/') for a in allowed)]
        if bad:
            fail('H2', name, {'unauthorizedPointers': bad})
    generated = policy.get('generatedPaths', [])
    allowed = policy['allowedPaths']
    for name in sorted(set(initial) | set(final)):
        if name in protected or name in granular or initial.get(name) == final.get(name):
            continue
        entry = final.get(name, initial.get(name))
        if entry['type'] == 'directory':
            continue
        if any(fnmatch.fnmatchcase(name, pattern) for pattern in generated):
            continue
        if not any(fnmatch.fnmatchcase(name, pattern) for pattern in allowed):
            fail('H1', name, '产物变化超出公开允许范围')
    # 生产脏改不能只靠本函数判断。正式评分必须绑定语义检查结果及源代码复查。
    return {'passed': not violations, 'violations': violations,
            'pendingSemanticProtection': policy.get('semanticProtection', [])}
