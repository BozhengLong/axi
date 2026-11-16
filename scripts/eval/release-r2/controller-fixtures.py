"""仅为真实CLI/模拟API资格建立独立合成前序账本，绝不写正式账本。"""
from pathlib import Path
import datetime as dt,json,sys,hashlib
import controller as controller_module
sys.dont_write_bytecode=True
from controller import Ledger,digest,slots


def seed(study,label,task,product):
 study=Path(study);directory=study/'controller-integration'/label;directory.parent.mkdir(exist_ok=True);directory.mkdir()
 now=dt.datetime.now(dt.timezone.utc).timestamp()-5;iso=lambda n:dt.datetime.fromtimestamp(n,dt.timezone.utc).isoformat()
 auth={'T0':iso(now-3600),'T1':None,'preparationDeadline':iso(now-3600+72*3600),'absoluteDeadline':iso(now-3600+168*3600)}
 identity={'candidate':'dbe7e145d205c21b580d8c2ee2dcf58c408380d8','sourceHash':'14be06a50a8163d4461c1d6e6a498ede412b13dc927f80fa4cf323446a552855','v0':'963704be97150e268edd3fda484d68e0a18a1f8b','image':'fixed-qualification-image','model':'claude-opus-5-5','claude':'2.1.322','mockOnly':True}
 manifest={'identities':identity,'qualificationComplete':True,'commit':'synthetic-qualification','remoteCommit':'synthetic-qualification','engineeringHash':'synthetic','c7QualificationHash':'synthetic','controllerQualificationHash':'synthetic','facilityHash':'synthetic','dependencyHash':'synthetic','evidenceAuditHash':'synthetic','tasks':[{'id':f'T{i:02}','category':'R'+str((i-1)%4+1),'repository':'synthetic-'+str(i%8),'admitted':True,'manifestHash':'synthetic-'+str(i),'userDirty':True,'productionDirty':i<=4,'asyncBehavior':i<=10}for i in range(1,21)]}
 source=Path(controller_module.__file__).resolve();raw=source.read_bytes();checksum=hashlib.sha256(raw).hexdigest();archive=directory/'controller-source.py';archive.write_bytes(raw)
 index={'schema':1,'mockOnly':True,'files':[{'path':str(source),'sha256':checksum,'archive':str(archive.relative_to(study))}]};index_path=directory/'facility-index.json';index_path.write_text(json.dumps(index,indent=2)+'\n');manifest['facilityIndex']={'path':str(index_path.relative_to(study)),'sha256':hashlib.sha256(index_path.read_bytes()).hexdigest()};manifest['facilityHash']=digest(index)
 ledger=Ledger(directory);ledger.apply('initialize',{'authorization':auth,'identities':identity},now);ledger.apply('freeze',manifest,now);ledger.apply('begin',{},now)
 for slot in slots():
  claim={'id':slot['id'],'identities':identity,'manifestHash':digest(manifest),'facilityHash':manifest['facilityHash'],'requestLimit':slot['limit']}
  ledger.apply('claim',claim,now)
  if slot['task']==task and slot['product']==product:
   result={'ledgerLabel':label,'id':slot['id'],'task':task,'product':product,'mockOnly':True,'syntheticPriorSlots':True};(directory/'qualification-only.json').write_text(json.dumps(result,indent=2)+'\n');return result
  ledger.apply('launched',{'id':slot['id'],'processIdentity':'synthetic-prior-slot'},now)
  artifact='synthetic-artifact-'+slot['id'];execution='synthetic-execution-'+slot['id'];seal={'id':slot['id'],'candidate':identity['candidate'],'writersClosed':True,'manifestVerified':True,'traceHash':'synthetic-trace','artifactHash':artifact,'executionHash':execution,'cleanupHash':'synthetic-cleanup','forwardedGeneration':1,'receivedAttempts':1,'countTokens':0,'endedAt':now,'gradeSeconds':0,'views':[{'id':slot['id']+'/final','kind':'final','artifactHash':artifact}]}
  ledger.apply('seal',seal,now);ledger.apply('review',{'id':slot['id'],'artifactHash':artifact,'executionHash':execution,'gradeHash':'synthetic-grade','reviewEvidenceHash':'synthetic-review','reviewer':'qualification-fixture','classification':'PASS'},now)
 raise ValueError('未知任务或产品槽')


if __name__=='__main__':print(json.dumps(seed(*sys.argv[1:5])))
