"""仅在合成账本中缩短首次剩余执行时间；真实冷却、健康及第二次窗口不改动。"""
from pathlib import Path
import hashlib,json,sys
HERE=Path(__file__).resolve().parent
source=(HERE/'controller-fixtures.py').read_text()
before='assert 5<=claim_age<180'
assert source.count(before)==1
source=source.replace(before,"assert 5<=claim_age<(180 if task=='health' else 1800)")
scope={'__name__':'recovery_fixture','__file__':str(HERE/'controller-fixtures.py')}
exec(compile(source,str(HERE/'controller-fixtures.py'),'exec'),scope)
study,label,task,product=sys.argv[1:5]
result=scope['seed'](study,label,task,product,165 if task=='health' else 1770)
out=Path(study)/'controller-integration'/label
(out/'recovery-fixture-source.py').write_text(source)
(out/'recovery-fixture.json').write_text(json.dumps({'mockOnly':True,'originalSha256':hashlib.sha256((HERE/'controller-fixtures.py').read_bytes()).hexdigest(),'adaptedSha256':hashlib.sha256(source.encode()).hexdigest(),'change':'only mock initial claim age range by task kind; actual execution window and controller policy unchanged'},indent=2)+'\n')
print(json.dumps(result))
