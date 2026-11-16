"""用真实文件校准冻结输入重建；不启动模型。"""
from pathlib import Path
import sys, json, os, hashlib, shutil, copy
sys.dont_write_bytecode = True
from inputs import materialize

study = Path(sys.argv[1]).resolve()
out = study / 'input-materialization-qualification'
out.mkdir()
source = Path(__file__).with_name('inputs.py')
checksum = hashlib.sha256(source.read_bytes()).hexdigest()
(out / 'inputs.py').write_bytes(source.read_bytes())
cases = ['valid', 'extra-cache', 'changed-content', 'changed-mode', 'changed-link', 'parent-link', 'duplicate-path', 'traversal', 'missing-file', 'link-as-file', 'invalid-type']
(out / 'plan.json').write_text(json.dumps({'cases': cases, 'repeats': 5, 'sourceHash': checksum}, indent=2) + '\n')
rows = []
for case in cases:
    for repeat in range(1, 6):
        run = out / f'{case}-{repeat}'
        initial = run / 'initial'
        for name in ['.git', 'src', 'dist', 'node_modules', 'coverage']:
            (initial / name).mkdir(parents=True, exist_ok=True)
        (initial / '.git/HEAD').write_text('synthetic input metadata\n')
        (initial / 'src/value.txt').write_text('source\n')
        (initial / 'dist/built.js').write_text('tracked generated content\n')
        (initial / 'link').symlink_to('src/value.txt')
        (initial / 'node_modules/cache').write_text('development cache\n')
        (initial / 'coverage/old.json').write_text('{}\n')
        entries = []
        for name in ['src/value.txt', 'dist/built.js', 'link']:
            path = initial / name
            record = {'path': name, 'type': 'symlink' if path.is_symlink() else 'file', 'mode': path.lstat().st_mode & 511}
            if path.is_symlink(): record['target'] = os.readlink(path)
            else: record['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
            entries.append(record)
        manifest = {'files': entries}
        if case == 'extra-cache': (initial / 'extra-test.js').write_text('not part of input\n')
        elif case == 'changed-content': (initial / 'src/value.txt').write_text('modified\n')
        elif case == 'changed-mode': (initial / 'src/value.txt').chmod(0o400)
        elif case == 'changed-link':
            (initial / 'link').unlink(); (initial / 'link').symlink_to('dist/built.js')
        elif case == 'parent-link':
            (initial / 'src').rename(run / 'outside'); (initial / 'src').symlink_to('../outside')
        elif case == 'duplicate-path': entries.append(copy.deepcopy(entries[0]))
        elif case == 'traversal': entries[0]['path'] = '../outside'
        elif case == 'missing-file': (initial / 'src/value.txt').unlink()
        elif case == 'link-as-file':
            (initial / 'src/value.txt').unlink(); (initial / 'src/value.txt').symlink_to('../dist/built.js'); entries[0]['mode'] = (initial / 'src/value.txt').lstat().st_mode & 511
        elif case == 'invalid-type': entries[0]['type'] = 'directory'
        (run / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        error = None
        try:
            materialize(initial, run / 'work', manifest)
        except (AssertionError, FileNotFoundError) as failure:
            error = {'name': type(failure).__name__, 'message': str(failure)}
        assert (error is None) == (case in ['valid', 'extra-cache'])
        if error is None:
            work = run / 'work'
            found = {str(p.relative_to(work)) for p in work.rglob('*') if '.git' not in p.relative_to(work).parts and (p.is_file() or p.is_symlink())}
            assert found == {'src/value.txt', 'dist/built.js', 'link'}
            assert (work / 'dist/built.js').read_text() == 'tracked generated content\n'
            assert os.readlink(work / 'link') == 'src/value.txt'
        row = {'case': case, 'repeat': repeat, 'qualified': True, 'rejection': error}
        rows.append(row)
        (run / 'result.json').write_text(json.dumps(row, indent=2) + '\n')
assert hashlib.sha256(source.read_bytes()).hexdigest() == checksum
(out / 'results.json').write_text(json.dumps({'qualified': True, 'cases': len(rows), 'rows': rows}, indent=2) + '\n')
print(json.dumps({'qualified': True, 'cases': len(rows)}))
