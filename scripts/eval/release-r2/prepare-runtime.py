"""只按本批冻结清单准备CLI输入。输出位置必须在研究目录内。"""
from pathlib import Path
import datetime,json,sys
sys.dont_write_bytecode=True
from inputs import materialize
study=Path(sys.argv[1]).resolve();task_id=sys.argv[2];out=Path(sys.argv[3]).resolve()
assert out.is_relative_to(study) and not out.exists()
task=study/('c7'if task_id.startswith('C7-')else'tasks')/task_id
assert task.is_dir() and task.parent.parent==study
materialize(task/'initial',out,json.loads((task/'input-manifest.json').read_text()))
print(json.dumps({'seed':str(out),'task':task_id}))
