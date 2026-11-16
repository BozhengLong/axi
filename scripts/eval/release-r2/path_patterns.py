"""按路径组件匹配；单个*不能跨目录，**可以。"""
import fnmatch
from functools import lru_cache


@lru_cache(maxsize=32768)
def matches(name, pattern):
    parts, rules = tuple(name.split('/')), tuple(pattern.split('/'))
    @lru_cache(maxsize=None)
    def visit(i, j):
        if j == len(rules):
            return i == len(parts)
        if rules[j] == '**':
            return visit(i, j + 1) or (i < len(parts) and visit(i + 1, j))
        return i < len(parts) and fnmatch.fnmatchcase(parts[i], rules[j]) and visit(i + 1, j + 1)
    return visit(0, 0)
