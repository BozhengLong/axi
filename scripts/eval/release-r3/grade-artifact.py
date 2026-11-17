"""R3资格入口；评分语义显式复用未改动的R2核心。"""
from pathlib import Path
import importlib.util,json,sys,datetime as dt
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
sys.path.append(str(HERE.parent/'release-r2'))
spec=importlib.util.spec_from_file_location('r2_grade_artifact',HERE.parent/'release-r2/grade-artifact.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
grade=module.grade

if __name__=='__main__':
    from qualification_guard import allowed
    study=Path(sys.argv[1]).resolve();task=sys.argv[2];artifact=Path(sys.argv[3]).resolve();out=Path(sys.argv[4]).resolve();seconds=float(sys.argv[5])
    assert sys.argv[6:]==['--development'] and 0<seconds<=720
    assert artifact.is_relative_to(study) and out.is_relative_to(study)
    window=allowed(study,task);seconds=min(seconds,dt.datetime.fromisoformat(window['deadline']).timestamp()-dt.datetime.now(dt.timezone.utc).timestamp());assert seconds>0
    result=grade(study,task,artifact,out,seconds,context={'stage':'R3-development'})
    print(json.dumps(result));sys.exit(0 if result['automaticChecksPassed'] else 1)
