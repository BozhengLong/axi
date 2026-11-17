"""在R3材料上重跑未变的快照/回归判定资格，适配任务目录并保存实际执行源码。"""
from pathlib import Path
import hashlib,json,sys
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
kind=sys.argv.pop(1);assert kind in ('capture','c7-regression')
original=HERE.parent/'release-r2'/(kind+'-qualification.py');source=original.read_text()
if kind=='capture':
    assert source.count("'tasks/T02'")==1;source=source.replace("'tasks/T02'","'tasks/U02'")
needle='out.mkdir();'
assert source.count(needle)==1
source=source.replace(needle,"out.mkdir();(out/'r3-adapted-source.py').write_text(R3_SOURCE);(out/'r3-wrapper.py').write_bytes(R3_WRAPPER.read_bytes());")
sys.path.append(str(original.parent))
exec(compile(source,str(original),'exec'),{'__name__':'__main__','__file__':str(original),'R3_SOURCE':source,'R3_WRAPPER':Path(__file__).resolve()})
