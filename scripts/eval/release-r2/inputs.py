"""仅按冻结清单重建输入，避免把开发缓存带进下一次资格。"""
from pathlib import Path
import hashlib
import os
import shutil


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
