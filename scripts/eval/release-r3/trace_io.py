"""读取普通或分块JSONL，检查完整字节与关闭记录，不加载整个会话。"""
from pathlib import Path
import hashlib
import json


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(65536), b''):
            h.update(block)
    return h.hexdigest()


def chunks(directory):
    directory = Path(directory)
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError('分块证据目录无效')
    manifest_path = directory/'manifest.json'
    if manifest_path.is_symlink():
        raise ValueError('分块清单不能是符号链接')
    manifest = json.loads(manifest_path.read_text())
    if manifest.get('schema') != 1 or manifest.get('status') != 'closed':
        raise ValueError('分块证据未关闭')
    paths = []
    total = 0
    for i, entry in enumerate(manifest['chunks']):
        if entry['name'] != f'{i:08}.bin':
            raise ValueError('分块顺序不符')
        path = directory/entry['name']
        if path.is_symlink() or not path.is_file() or path.stat().st_size != entry['bytes'] or sha(path) != entry['sha256']:
            raise ValueError('分块内容不符')
        total += entry['bytes'];paths.append(path)
    if total != manifest['bytes'] or {p.name for p in directory.iterdir()} != {'manifest.json', *(p.name for p in paths)}:
        raise ValueError('分块字节数或文件清单不符')
    return paths


def events(path, max_line_bytes=64*1024*1024):
    path = Path(path)
    paths = chunks(path if path.is_dir() else path.with_suffix('.chunks')) if not path.is_file() else [path]
    buffer = bytearray()
    for item in paths:
        if item.is_symlink():
            raise ValueError('事件文件不能是符号链接')
        with item.open('rb') as stream:
            for block in iter(lambda: stream.read(65536), b''):
                buffer.extend(block)
                while True:
                    index = buffer.find(b'\n')
                    if index < 0:
                        break
                    if index > max_line_bytes:
                        raise ValueError('事件记录超过声明的解析窗口')
                    line = bytes(buffer[:index]);del buffer[:index+1]
                    if line.strip():
                        yield json.loads(line)
                if len(buffer) > max_line_bytes:
                    raise ValueError('事件记录超过声明的解析窗口')
    # JSONL末条可省略换行，但必须本来就是完整JSON，不能补括号或忽略残片。
    if buffer.strip():
        yield json.loads(buffer)


def verify_run(run):
    run = Path(run).resolve();batch = run.parent
    manifest = json.loads((run/'trace-manifest.json').read_text())
    if manifest.get('version') != 3 or manifest.get('status') != 'complete_observable':
        raise ValueError('不是完整R3执行证据')
    names = set()
    for entry in manifest['files']:
        path = run/entry['path']
        if entry['path'] in names or not path.resolve().is_relative_to(batch) or path.is_symlink() or not path.is_file():
            raise ValueError('证据路径不符')
        parent = path.parent
        while parent != batch:
            if parent.is_symlink() or not parent.resolve().is_relative_to(batch):
                raise ValueError('证据父路径不符')
            parent = parent.parent
        names.add(entry['path'])
        if path.stat().st_size != entry['bytes'] or sha(path) != entry['sha256']:
            raise ValueError('证据文件改变')
    required = {'execution.json','writers-closed.json','native/manifest.json','io.chunks/manifest.json',f'../relay/{run.name}.chunks/manifest.json'}
    if not required.issubset(names):
        raise ValueError('关键证据未纳入清单')
    closed = json.loads((batch/'relay-closed.json').read_text())
    writers = json.loads((run/'writers-closed.json').read_text())
    if writers['relay'] != closed['name'] or closed['remaining'] or writers['unfinishedRequests'] != 0:
        raise ValueError('写入者未停止')
    seals = json.loads((batch/'sealed-traces.json').read_text())['seals']
    selected = [s for s in seals if s['id'] == run.name]
    if len(selected) != 1 or selected[0]['manifestHash'] != sha(run/'trace-manifest.json'):
        raise ValueError('封存清单未绑定')
    return manifest
