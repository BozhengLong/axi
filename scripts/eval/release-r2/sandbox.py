"""独立Linux评分工作卷。被测产物不经macOS文件系统展开，避免大小写与模式丢失。"""
from pathlib import Path
import datetime
import json
import os
import subprocess
import time
import uuid
from inputs import materialize

HERE = Path(__file__).parent.resolve()


def save(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


class Sandbox:
    def __init__(self, study, task, profile, case, deadline, files=None):
        self.study, self.task, self.profile, self.case = Path(study), Path(task), profile, Path(case)
        self.deadline = deadline
        self.name = 'axi-r2-grade-' + uuid.uuid4().hex[:16]
        self.volume = self.name + '-task'
        self.image = profile['image']
        self.case.mkdir()
        self.files = files
        self.created = False
        self.running = False

    def command(self, args, label, limit=None):
        save(self.case / (label + '.command.json'), args)
        started = time.monotonic()
        timeout = max(.1, self.deadline - started - 3)
        if label.startswith('cleanup-'):
            timeout = max(timeout, 5)
        if limit:
            timeout = min(timeout, limit)
        try:
            with (self.case / (label + '.stdout')).open('wb') as out, (self.case / (label + '.stderr')).open('wb') as err:
                result = subprocess.run(args, stdout=out, stderr=err, timeout=timeout)
            record = {'code': result.returncode, 'seconds': time.monotonic() - started, 'timedOut': False}
        except subprocess.TimeoutExpired:
            record = {'code': None, 'seconds': time.monotonic() - started, 'timedOut': True}
        save(self.case / (label + '.process.json'), record)
        return record

    def checked(self, args, label, limit=None):
        result = self.command(args, label, limit)
        if result['code'] != 0 or result['timedOut']:
            raise RuntimeError('评分设施命令失败: ' + label)
        return result

    def __enter__(self):
        try:
            seed = self.case / 'seed'
            materialize(self.task / 'initial', seed, json.loads((self.task / 'input-manifest.json').read_text()))
            self.checked(['docker', 'volume', 'create', self.volume], 'volume-create', 10)
            self.created = True
            common = ['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop=ALL', '-v', self.volume + ':/task']
            self.checked(common + ['--user', '0', '--cap-add=CHOWN', '--entrypoint', 'chown', self.image, '1000:1000', '/task'], 'volume-owner', 10)
            self.checked(common + ['--user', '1000:1000', '-v', str(seed) + ':/seed:ro', '--entrypoint', 'cp', self.image, '-R', '-P', '--preserve=mode', '/seed/.', '/task/'], 'seed', 30)
            if self.files is not None:
                save(self.case / 'restore-files.json', self.files)
                self.checked(common + ['--user', '1000:1000', '-v', str(self.case / 'restore-files.json') + ':/files.json:ro', '-v', str(HERE / 'restore.mjs') + ':/restore.mjs:ro', '--entrypoint', 'node', self.image, '/restore.mjs', '/files.json'], 'restore', 30)
            args = ['docker', 'run', '-d', '--name', self.name, '--network', 'none', '--user', '1000:1000', '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--cpus', '2', '--memory', '4g', '--pids-limit', '256', '--tmpfs', '/tmp:rw,exec,size=1g', '-e', 'HOME=/tmp/home', '-e', 'TMPDIR=/tmp', '-v', self.volume + ':/task', '-v', str(self.case) + ':/evidence', '-v', str(HERE / 'reporters') + ':/reporters:ro', '-v', str(HERE / 'bun-observer.ts') + ':/observer.ts:ro', '-v', str(self.task / 'qualification-material') + ':/grade:ro']
            for mount in self.profile.get('dependencyMounts', []):
                source = (self.study / mount['source']).resolve()
                if not source.is_relative_to(self.study):
                    raise ValueError('依赖不在本批目录')
                args += ['-v', str(source) + ':' + mount['target'] + ':ro']
            for name in self.profile.get('dependencyPaths', []):
                args += ['--mount', 'type=volume,src=' + self.profile['dependencyVolume'] + ',dst=/task/' + name + ',volume-subpath=' + name + ',readonly']
            for mount in self.profile.get('cacheTmpfs', []):
                args += ['--tmpfs', mount]
            task_environment=dict(self.profile.get('environment', {}))
            if task_environment.get('NX_CACHE_DIRECTORY'):
                task_environment['NX_SKIP_NATIVE_FILE_CACHE']='true'
            for key, value in task_environment.items():
                if key not in ('NODE_PATH','NX_CACHE_DIRECTORY','NX_WORKSPACE_DATA_DIRECTORY','NX_DAEMON','NX_SKIP_NATIVE_FILE_CACHE'):
                    raise ValueError('未允许的构建环境')
                args += ['-e', key + '=' + value]
            args += ['-w', '/task', '--entrypoint', 'sleep', self.image, 'infinity']
            self.running = True
            self.checked(args, 'container', 30)
            return self
        except BaseException:
            self.close()
            raise

    def run(self, step):
        label = step['label']
        if not label.replace('-', '').replace('_', '').isalnum():
            raise ValueError('不合法证据标签')
        args = ['docker', 'exec', '-e', 'AXI_RESULT_PATH=/evidence/' + label + '.native.json', '-e', 'AXI_BUN_ASSERTIONS_PATH=/evidence/' + label + '.assertions.jsonl', self.name, *step['args']]
        return self.command(args, label)

    def capture(self, label):
        self.checked(['docker', 'pause', self.name], label + '-pause', 5)
        try:
            args = ['docker', 'run', '--rm', '--network', 'none', '--user', '1000:1000', '--read-only', '--cap-drop=ALL', '--cpus', '1', '--memory', '512m', '--pids-limit', '64', '--tmpfs', '/tmp:rw,size=64m', '-v', self.volume + ':/task:ro', '-v', str(HERE / 'capture.mjs') + ':/capture.mjs:ro', '--entrypoint', 'node', self.image, '/capture.mjs']
            self.checked(args, label + '-capture', 60)
            value = json.loads((self.case / (label + '-capture.stdout')).read_text())
            save(self.case / (label + '-snapshot.json'), value)
            return value
        finally:
            self.checked(['docker', 'unpause', self.name], label + '-unpause', 5)

    def close(self):
        rows = []
        if self.running:
            rows.append(self.command(['docker', 'rm', '-f', self.name], 'cleanup-container', 10))
            self.running = False
        if self.created:
            rows.append(self.command(['docker', 'volume', 'rm', self.volume], 'cleanup-volume', 10))
            self.created = False
        save(self.case / 'cleanup.json', {'results': rows, 'complete': all(r['code'] == 0 and not r['timedOut'] for r in rows)})
        if not all(r['code'] == 0 and not r['timedOut'] for r in rows):
            raise RuntimeError('评分资源未完整清理')

    def __exit__(self, *_):
        self.close()
