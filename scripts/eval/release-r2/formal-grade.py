"""为已经封存的真实槽评分。固定共享窗口，不重启旧评分，不启动模型。"""
from pathlib import Path
import datetime as dt,importlib.util,json,os,sys,time,subprocess
sys.dont_write_bytecode=True
HERE=Path(__file__).parent

def load(name):
 spec=importlib.util.spec_from_file_location(name.replace('-','_'),HERE/(name+'.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

gateway=load('controller-gateway');grader=load('grade-artifact');study=Path(sys.argv[1]).resolve();slot_id=sys.argv[2]
label=sys.argv[4]if len(sys.argv)==5 and sys.argv[3]=='--mock-ledger'else None
if label:
    load('qualification_guard').allowed(study)
    state=gateway.apply(study,'status',{'ledgerLabel':label},'mock')['state'];gateway.require(state['identities'].get('mockOnly')is True,'模拟评分必须读取合成账本')
else:
    gateway.require(len(sys.argv)==3,'未知正式评分参数')
    state,_=gateway.read_state(study/'formal-controller');gateway.verify_admission(study,state['manifest'],state.get('repair'))
claim=state['claims'][slot_id];gateway.require('seal'in claim,'执行尚未封存')
output=study/claim['seal']['output'];gateway.require(output.resolve().is_relative_to(study),'评分输出越界')
if not label:gateway.require(output==study/'runs'/slot_id,'评分输出不属于固定槽')
repair_id=os.environ.get('AXI_GRADING_REPAIR_ID');repair=state.get('repair');is_repair=bool(repair_id)
if is_repair:
 gateway.require(repair and repair_id==repair.get('repairId')and not repair.get('completedAt')and state['paused'],'没有已登记的评分修复')
 gateway.require(all(view['id']in repair['affectedViews']for view in claim['seal']['views']),'槽视图不在修复范围')
 destination=study/'repairs'/repair_id/'grades'/slot_id;destination.mkdir(parents=True,exist_ok=False)
 end_limit=min(repair['deadline'],state['formalDeadline']-3*3600)
else:
 gateway.require(not state['paused']and not state['closure']and 'review'not in claim,'当前槽不允许首次评分')
 destination=output;end_limit=state['formalDeadline']-3*3600
start=time.monotonic();start_wall=time.time();seconds=min(900,end_limit-start_wall);gateway.require(seconds>0,'评分和收尾时间不足')
process_identity=subprocess.check_output(['ps','-p',str(os.getpid()),'-o','lstart=,command='],text=True).strip()
with(destination/'grading-start.json').open('x')as f:
    json.dump({'pid':os.getpid(),'processIdentity':process_identity,'startedAt':dt.datetime.now(dt.timezone.utc).isoformat(),'deadline':start_wall+seconds,'sharedSeconds':seconds,'slot':slot_id,'repairId':repair_id},f,indent=2);f.flush();os.fsync(f.fileno())
rows=[]
for view in claim['seal']['views']:
 kind=view['kind'];artifact=output/(kind+'-snapshot.json');gateway.require(gateway.sha(artifact)==view['artifactHash'],'评分不能替换封存产物')
 remaining=seconds-(time.monotonic()-start);gateway.require(remaining>0,'最终与检查点共享窗口耗尽')
 context={'stage':'grading-repair'if is_repair else'formal','slot':slot_id,'view':kind,'repairId':repair_id,'executionHash':claim['seal']['executionHash']}
 result=grader.grade(study,claim['slot']['task'],artifact,destination/(kind+'-grade'),remaining,context=context)
 rows.append({'view':kind,'sha256':gateway.sha(destination/(kind+'-grade/result.json')),'gradeStatus':result['gradeStatus'],'automaticChecksPassed':result['automaticChecksPassed']})
summary={'slot':slot_id,'sharedSeconds':time.monotonic()-start,'views':rows,'repairId':repair_id,'finishedAt':dt.datetime.now(dt.timezone.utc).isoformat()}
(destination/'grading-summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary))
