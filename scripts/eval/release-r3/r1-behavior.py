"""对C3重新执行两平台真文件、CLI和错误变体；只复用驱动代码。"""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import subprocess
import sys
import time

study = Path(sys.argv[1]).resolve()
repo = Path(__file__).resolve().parents[3]
env = json.loads((study / 'toolchain/verification.json').read_text())['env']
identity = json.loads((study / 'candidate.json').read_text())
assert json.loads((study / 'base-engineering-2/results.json').read_text())['qualified']
output = study / 'behavior-engineering-1'
output.mkdir()
image = 'sha256:2c28b2b381ad0647f6a95afbd781e0d27e06a892fd40a164ac0dcb753fb92ba1'
steps = [('engineering', 'engineering.ts', []), ('engineering-write', 'engineering.ts', ['write']),
         ('identity-cli', 'identity-cli.ts', []), ('identity-cli-extra', 'identity-cli-extra.ts', []),
         ('install-cli', 'install-cli.ts', []), ('control-cli', 'control-cli.ts', []),
         ('mutations', 'mutations.ts', []), ('legacy-mutations', 'legacy-mutations.ts', [])]
sources = {}
for path in (repo / 'scripts/eval/release-r2').glob('*.ts'):
    sources[str(path.relative_to(repo))] = hashlib.sha256(path.read_bytes()).hexdigest()
(output / 'plan.json').write_text(json.dumps({'candidate': identity, 'steps': steps, 'driverHashes': sources}, indent=2) + '\n')


def check(platform):
    rows = []
    for label, script, tail in steps:
        name = f'c3-{platform}-{label}-1'
        if platform == 'macos':
            args = ['bun', str(repo / 'scripts/eval/release-r2' / script), str(study / 'candidate-macos-2'),
                    str(study / 'candidate-source.json'), str(study / name), platform, *tail]
        else:
            args = ['docker', 'run', '--rm', '--label', 'axi.eval.study=' + study.name,
                    '--name', 'axi-r3-' + label, '--network', 'none', '--cpus', '2', '--memory', '4g',
                    '--user', '1000:1000', '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=1g,mode=1777',
                    '-v', str(study / 'candidate-linux-2') + ':/candidate:ro', '-v', str(repo) + ':/facility:ro',
                    '-v', str(study) + ':/study', '-w', '/candidate', '-e', 'TMPDIR=/tmp', '-e', 'HOME=/tmp/eval-home',
                    '-e', 'BUN_INSTALL_CACHE_DIR=/tmp/bun-cache', '-e', 'GIT_CONFIG_GLOBAL=/dev/null', '-e', 'GIT_CONFIG_NOSYSTEM=1',
                    '-e', 'npm_config_package_manager_strict=false', '-e', 'npm_config_manage_package_manager_versions=false',
                    image, 'bun', '/facility/scripts/eval/release-r2/' + script, '/candidate', '/study/candidate-source.json',
                    '/study/' + name, platform, *tail]
        started = time.time()
        prefix = output / (platform + '-' + label)
        with prefix.with_suffix('.stdout').open('wb') as out, prefix.with_suffix('.stderr').open('wb') as err:
            process = subprocess.run(args, env=env, stdout=out, stderr=err)
        row = {'platform': platform, 'label': label, 'command': args, 'exitCode': process.returncode, 'seconds': time.time() - started}
        prefix.with_suffix('.json').write_text(json.dumps(row, indent=2) + '\n')
        rows.append(row)
        print(json.dumps(row), flush=True)
        if process.returncode:
            break
    return {'platform': platform, 'qualified': len(rows) == len(steps) and all(r['exitCode'] == 0 for r in rows), 'rows': rows}


with ThreadPoolExecutor(max_workers=2) as pool:
    results = list(pool.map(check, ('macos', 'linux')))
summary = {'candidate': identity['candidate'], 'sourceHash': identity['sourceHash'], 'platforms': results,
           'qualified': all(x['qualified'] for x in results), 'realModelStarts': 0}
(output / 'results.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps({'qualified': summary['qualified'], 'platforms': [{k: v for k, v in x.items() if k != 'rows'} for x in results]}), flush=True)
sys.exit(0 if summary['qualified'] else 1)
