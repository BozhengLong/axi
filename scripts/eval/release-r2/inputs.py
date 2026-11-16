"""仅按冻结清单重建输入，避免把开发缓存带进下一次资格。"""
from pathlib import Path
import hashlib
import os
import shutil
import subprocess


def git_identity(initial):
    result = {}
    for name, args in [('head', ['rev-parse', 'HEAD']), ('index', ['ls-files', '--stage', '-z']), ('status', ['status', '--porcelain=v1', '-z', '--untracked-files=all'])]:
        p = subprocess.run(['git', '--no-optional-locks', '-C', str(initial), *args], capture_output=True, check=True)
        result[name] = hashlib.sha256(p.stdout).hexdigest()
    return result


def verify_initial(initial, manifest, expected_git=None):
    initial = Path(initial)
    assert (initial / '.git').is_dir() and not (initial / '.git').is_symlink()
    seen = set()
    for entry in manifest['files']:
        name = entry['path']; path = initial / name
        assert name not in seen and not Path(name).is_absolute() and '..' not in Path(name).parts and '.git' not in Path(name).parts
        seen.add(name)
        for parent in path.parents:
            if parent == initial: break
            assert parent.is_relative_to(initial) and not parent.is_symlink()
        assert path.lstat().st_mode & 511 == entry['mode'], '初态模式变化: ' + name
        if entry.get('type', 'file') == 'symlink':
            assert path.is_symlink() and os.readlink(path) == entry['target'], '初态链接变化: ' + name
        else:
            assert entry.get('type', 'file') == 'file' and path.is_file() and not path.is_symlink()
            assert hashlib.sha256(path.read_bytes()).hexdigest() == entry['sha256'], '初态内容变化: ' + name
    if expected_git is not None:
        assert git_identity(initial) == expected_git, '初态HEAD、索引或用户脏改变化'


def materialize(initial, work, manifest):
    initial = Path(initial)
    work = Path(work)
    work.mkdir()
    assert (initial / '.git').is_dir() and not (initial / '.git').is_symlink()
    shutil.copytree(initial / '.git', work / '.git', symlinks=True)
    seen = set()
    for entry in manifest['files']:
        name = entry['path']
        assert name not in seen and not Path(name).is_absolute() and '..' not in Path(name).parts
        assert '.git' not in Path(name).parts
        assert entry.get('type', 'file') in ['file', 'symlink']
        seen.add(name)
        source = initial / name
        for parent in source.parents:
            if parent == initial:
                break
            assert parent.is_relative_to(initial) and not parent.is_symlink()
        target = work / name
        target.parent.mkdir(parents=True, exist_ok=True)
        metadata = source.lstat()
        assert metadata.st_mode & 511 == entry['mode'], f'输入模式变化: {name}'
        if entry.get('type', 'file') == 'symlink':
            assert source.is_symlink() and os.readlink(source) == entry['target']
            target.symlink_to(entry['target'])
            if hasattr(os, 'lchmod'):
                os.lchmod(target, entry['mode'])
        else:
            assert source.is_file() and not source.is_symlink()
            data = source.read_bytes()
            assert hashlib.sha256(data).hexdigest() == entry['sha256'], f'输入内容变化: {name}'
            target.write_bytes(data)
            target.chmod(entry['mode'])
