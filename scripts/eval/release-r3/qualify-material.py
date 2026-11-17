"""适配旧确定性资格入口。只调整批次准入、任务ID和新证据路径，保持全部行为断言。"""
from pathlib import Path
import hashlib,json,sys
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent

def prepare(kind):
    assert kind in ('task','negative','c7','c7-negative')
    name={'task':'qualify-task.py','negative':'qualify-negative.py','c7':'qualify-c7.py','c7-negative':'qualify-c7-negative.py'}[kind]
    original=HERE.parent/'release-r2'/name
    source=original.read_text();changes=[]
    def replace(before,after,count=1):
        nonlocal source
        assert source.count(before)==count,(name,before,source.count(before))
        source=source.replace(before,after);changes.append({'before':before,'after':after,'occurrences':count})
    if kind in ('task','negative'):replace("re.fullmatch(r'T\\d\\d', task_id)","re.fullmatch(r'U\\d\\d', task_id)")
    if kind in ('task','c7'):
        replace("admission['stage'] == 'R2'","admission['qualified'] is True and json.loads((study / 'status.json').read_text())['phase'] == 'R2'")
    else:
        replace("json.loads((study / 'engineering-admission.json').read_text())['stage'] == 'R2'","json.loads((study / 'engineering-admission.json').read_text())['qualified'] is True and json.loads((study / 'status.json').read_text())['phase'] == 'R2'")
        replace("qualification = controls.get('positiveQualification', 'qualification-2')","qualification = 'qualification-' + sys.argv[4]")
    # 实际导入R3时间守卫；原报告器/输入复制/行为断言继续来自R2。
    replace("Path(__file__).with_name('qualification_guard.py')","R3_HERE / 'qualification_guard.py'")
    replace("[Path(__file__),", "[Path(__file__), R3_HERE / 'qualify-material.py',")
    replace('out.mkdir()',"out.mkdir()\n(out / 'adaptation.json').write_text(json.dumps(R3_ADAPTATION, ensure_ascii=False, indent=2) + '\\n')\n(out / 'adapted-source.py').write_text(R3_SOURCE)")
    return original,source,changes

if __name__=='__main__':
    kind=sys.argv.pop(1);original,source,changes=prepare(kind)
    sys.path.append(str(HERE.parent/'release-r2'))
    adaptation={'kind':kind,'original':str(original),'originalSha256':hashlib.sha256(original.read_bytes()).hexdigest(),'adaptedSha256':hashlib.sha256(source.encode()).hexdigest(),'changes':changes,'repeats':5,'assertionLogicUnchanged':True}
    exec(compile(source,str(original),'exec'),{'__name__':'__main__','__file__':str(original),'R3_HERE':HERE,'R3_ADAPTATION':adaptation,'R3_SOURCE':source})
