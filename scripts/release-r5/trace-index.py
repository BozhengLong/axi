"""为本批所有已封存 CLI 写本地索引，保留初次诊断及每次恢复尝试。"""
import hashlib
import json
from pathlib import Path
import sys


def read(file):
    return json.loads(file.read_text())


def main(study):
    documents = ['health/pipeline-*/batch.json', 'tasks/U*/pipeline-*/batch.json',
                 'c7/C7-*/pipeline-*/batch.json', 'recovery-interrupt-*/batch.json', 'runs/*/batch.json']
    rows = []
    seen = set()
    for pattern in documents:
        for file in sorted(study.glob(pattern)):
            folder = file.parent
            evidence = folder/'execution-evidence.json'
            if not evidence.exists():
                continue
            info = read(file)
            run = (Path(info['directory'])/info['runtimeId']).resolve()
            assert run.is_relative_to(study/'runtime') and run not in seen
            trace = run/'trace-manifest.json'
            execution = read(evidence)
            assert read(trace)['status']=='complete_observable'
            assert hashlib.sha256(trace.read_bytes()).hexdigest()==execution['traceHash']
            seen.add(run)
            rows.append((str(folder.relative_to(study)), execution['mockOnly'], str(run.relative_to(study)),
                         execution['traceHash'], execution['forwardedGeneration'],execution['completeResponses']))
    lines=['# 本批已封存 CLI 的可观察 Trace','',
           '每条记录绑定 Trace 清单的 SHA-256。CLI 原生会话在运行目录的 native 下，终端输入输出在 io.chunks 下。对应运行的代理请求和响应在同批次的 relay 目录。产物、评分及审查在槽位目录。','',
           '| 槽位目录 | 上游 | Trace 清单 | SHA-256 | 生成 / 完整响应 |','|---|---|---|---|---:|']
    for folder,mock,run,digest,requests,responses in rows:
        lines.append(f"| [{folder}]({folder}/) | {'模拟' if mock else '真实'} | [清单]({run}/trace-manifest.json) | `{digest}` | {requests} / {responses} |")
    lines.extend(['',f'已列 {len(rows)} 次，其中真实上游 {sum(not r[1] for r in rows)} 次。'])
    temporary = study/'TRACE-INDEX.md.tmp'
    with temporary.open('x') as f:
        f.write('\n'.join(lines)+'\n')
    temporary.chmod(0o600)
    temporary.replace(study/'TRACE-INDEX.md')
    print(len(rows),'indexed')


if __name__=='__main__':
    main(Path(sys.argv[1]).resolve())
