"""区分正式运行前准备与已登记的一次评分修复，原授权文件不承担可变状态。"""
from pathlib import Path
import datetime as dt
import importlib.util
import json
import os


def allowed(study, task_id=None):
    study=Path(study).resolve();auth=json.loads((study/'authorization.json').read_text());now=dt.datetime.now(dt.timezone.utc)
    ledger=study/'formal-controller/controller-events.jsonl'
    state=None
    if ledger.exists():
        path=Path(__file__).with_name('controller-gateway.py')
        spec=importlib.util.spec_from_file_location('controller_gateway',path);gateway=importlib.util.module_from_spec(spec);spec.loader.exec_module(gateway)
        state,_=gateway.read_state(ledger.parent)
    if state is None or state['T1']is None:
        if now>=dt.datetime.fromisoformat(auth['preparationDeadline']):raise RuntimeError('准备窗口已经结束')
        stage=json.loads((study/'stage.json').read_text())
        if stage.get('T1')is not None or stage.get('stage')not in ('R0','R1','R2'):raise RuntimeError('当前状态不允许准备资格')
        return {'mode':'preparation','deadline':auth['preparationDeadline']}
    repair=state.get('repair');token=os.environ.get('AXI_GRADING_REPAIR_ID')
    if state.get('closure')or not state.get('paused')or not repair or repair.get('completedAt')or token!=repair.get('repairId'):
        raise RuntimeError('正式运行后仅允许已登记的同契约评分修复资格')
    if now.timestamp()>=repair['deadline']:raise RuntimeError('评分修复窗口已经结束')
    if task_id and repair['scope']=='tasks'and task_id not in repair['scopeTasks']:raise RuntimeError('题目不在已登记修复范围')
    return {'mode':'grading-repair','deadline':dt.datetime.fromtimestamp(repair['deadline'],dt.timezone.utc).isoformat(),'repairId':token}


if __name__=='__main__':
    import sys
    print(json.dumps(allowed(sys.argv[1],sys.argv[2]if len(sys.argv)>2 else None)))
