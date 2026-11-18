"""沿用原捕获检查，把旧任务编号 T02 映射到当前的 U02。"""
import json
import sys
from pathlib import Path

root=Path(__file__).resolve().parents[1]/'eval/release-r2'
sys.dont_write_bytecode=True
sys.path.insert(0,str(root))
original=root/'capture-qualification.py'
source=original.read_text()
assert source.count("task=study/'tasks/T02'")==1
source=source.replace("task=study/'tasks/T02'","task=study/'tasks/U02'")
study=Path(sys.argv[1]).resolve()
assert json.loads((study/'status.json').read_text())['phase']=='R2'
archive=study/('capture-qualification-'+sys.argv[2]+'.py')
with archive.open('x') as output:
    output.write(source)
exec(compile(source,str(original),'exec'),{'__file__':str(original),'__name__':'__main__'})
