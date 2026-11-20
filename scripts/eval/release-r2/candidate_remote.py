"""在打包时核对当批授权的候选引用，后续审查使用冻结结果。"""
import hashlib
import json
from pathlib import Path
import re
import subprocess


def _object_id(value):
    return isinstance(value, str) and re.fullmatch(r'[0-9a-f]{40}', value) is not None


def _valid_ref(ref):
    if not isinstance(ref, str) or not ref.startswith(('refs/heads/', 'refs/tags/')):
        return False
    return subprocess.run(['git', 'check-ref-format', ref], capture_output=True).returncode == 0


def freeze_candidate_ref(repo: Path, authorization, identity, candidate, source):
    ref = authorization.get('candidateRef')
    if not _valid_ref(ref):
        raise ValueError('批次授权须登记完整的候选引用 candidateRef（refs/heads/ 或 refs/tags/）')

    commit, source_hash = identity['candidate'], identity['sourceHash']
    declared = {'candidate': commit, 'sourceHash': source_hash}
    if ('candidateIdentity' in authorization and authorization['candidateIdentity'] != declared
            or not _object_id(commit) or any(candidate.get(k) != v for k, v in declared.items())):
        raise ValueError('候选提交或源码哈希与本批身份不符')
    files = json.dumps(source['files'], ensure_ascii=False, separators=(',', ':')).encode()
    if (source.get('kind') != 'candidate' or source.get('commit') != commit
            or source.get('sourceHash') != source_hash
            or hashlib.sha256(files).hexdigest() != source_hash):
        raise ValueError('候选源码清单与本批身份不符')

    peeled = ref + '^{}'
    requested = {ref, peeled} if ref.startswith('refs/tags/') else {ref}
    try:
        result = subprocess.run(
            ['git', 'ls-remote', '--exit-code', 'origin', *sorted(requested)],
            cwd=repo, capture_output=True, text=True, timeout=30,
        )
    except subprocess.TimeoutExpired:
        raise ValueError('查询候选远端引用超时') from None
    if result.returncode not in (0, 2):
        raise ValueError('无法查询 origin 的候选引用')
    found = {}
    for line in result.stdout.splitlines():
        object_id, separator, name = line.partition('\t')
        # ls-remote 按引用尾部匹配，再核对完整名称。
        if not separator or name not in requested:
            continue
        if name in found or not _object_id(object_id):
            raise ValueError('远端候选引用返回重复或无效的对象 ID')
        found[name] = object_id
    if ref not in found:
        raise ValueError(f'origin 缺少本批候选引用 {ref}')
    if found.get(peeled, found[ref]) != commit:
        raise ValueError(f'候选远端引用 {ref} 未指向本批冻结提交')
    return {'ref': ref, 'object': found[ref], 'commit': commit, 'sourceHash': source_hash}


def verify_candidate_ref(authorization, manifest):
    # 已封存的旧批次沿用原清单。新打包入口总会写入候选引用见证。
    if 'candidateRef' not in authorization and 'candidateGit' not in manifest:
        return
    ref = authorization.get('candidateRef')
    proof = manifest.get('candidateGit')
    if not _valid_ref(ref) or not isinstance(proof, dict) or proof.get('ref') != ref:
        raise ValueError('冻结清单的候选引用与本批授权不符')
    identity = manifest['identities']
    declared = {'candidate': identity['candidate'], 'sourceHash': identity['sourceHash']}
    if ('candidateIdentity' in authorization and authorization['candidateIdentity'] != declared
            or not _object_id(proof.get('object')) or not _object_id(proof.get('commit'))
            or proof['commit'] != declared['candidate'] or proof.get('sourceHash') != declared['sourceHash']
            or (ref.startswith('refs/heads/') and proof['object'] != proof['commit'])):
        raise ValueError('候选远端见证与本批冻结身份不符')
