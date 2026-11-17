"""以65条当前流程、两条恢复链和大Trace实测冻结73次容量估算。"""
from pathlib import Path
import datetime as dt,json,math,os,subprocess,sys
sys.dont_write_bytecode=True
study=Path(sys.argv[1]).resolve();revision=sys.argv[2];recovery_revision=sys.argv[3]
out=study/('resource-policy-'+revision);out.mkdir()
read=lambda p:json.loads(Path(p).read_text())
def tree(root):
    logical=allocated=0
    for base,dirs,names in os.walk(root,followlinks=False):
        dirs[:]=[d for d in dirs if not(Path(base)/d).is_symlink()]
        for name in names:
            p=Path(base)/name;s=p.lstat()
            if p.is_file()and not p.is_symlink():logical+=s.st_size;allocated+=s.st_blocks*512
    return {'logicalBytes':logical,'allocatedBytes':allocated}
queue=read(study/('pipeline-queue-'+revision)/'result.json');assert queue['qualified']and len(queue['rows'])==65
recovery=read(study/('recovery-chains-'+recovery_revision)/'result.json');assert recovery['qualified']and recovery['recoveryChains']==2 and recovery['recoveryCli']==7
rows=queue['rows'];measure=lambda r:max(r['logicalBytes'],r['allocatedBytes'])
normal=sum(measure(r)for r in rows);health=max(measure(r)for r in rows if r['task']=='health');task=max(measure(r)for r in rows if r['task']!='health')
stress=[]
for i in range(320,325):
    result=read(study/f'runtime-qualification-{i}/results.json');assert result['qualified']
    r=result['rows'][0];assert r['kind']=='large-trace'and r['requests']==28001 and r['terminalBytes']>200*2**20 and r['events']>100000
    stress.append({'proof':f'runtime-qualification-{i}/results.json',**tree(Path(r['traceDirectory']).parent)})
stress_peak=max(max(r['logicalBytes'],r['allocatedBytes'])for r in stress)
recovery_measured=tree(study/('recovery-chains-'+recovery_revision))
for chain in recovery['chains']:
    state=read(study/'controller-integration'/chain['label']/'qualification-only.json')
    # 恢复链的全部实际运行绑定到其账本；每条输出及trace各测一次。
    ledger=[json.loads(line)for line in(study/'controller-integration'/chain['label']/'controller-events.jsonl').read_text().splitlines()][-1]['state']
    seen=set()
    for c in ledger['claims'].values():
        seal=c.get('seal',{})
        if 'output' not in seal:continue
        p=study/seal['output'];roots=[p,Path(read(p/'execution-result.json')['traceDirectory']).parent]
        for root in roots:
            if str(root)in seen:continue
            seen.add(str(root));d=tree(root)
            for k,v in d.items():recovery_measured[k]+=v
working=max(r['workingAllocatedPeak']for r in rows)
assert working>0 and all(r['resourceSamples']>0 for r in rows)
# 65个正常槽加6健康、2重跑共73；另留两份大Trace增长余量及一个工作峰值。
extra=max(6*health+2*task,recovery_measured['logicalBytes'],recovery_measured['allocatedBytes'])
future=normal+extra+2*stress_peak+working+4*2**30
minimum=max(57*2**30,math.ceil(1.5*future+9*2**30))
stat=os.statvfs(study);available=stat.f_bavail*stat.f_frsize
info=json.loads(subprocess.check_output(['docker','info','--format','{{json .}}'],text=True))
result={'qualified':True,'capacityCurrentlySatisfied':available>=minimum,'minimumFreeBytes':minimum,'operatingFloorBytes':9*2**30,'minimumDockerMemoryBytes':int(5.5*2**30),'minimumDockerCpus':2,'normalSlots':65,'maximumAttempts':73,'measuredNormalEvidenceBytes':normal,'extraRecoveryEvidenceBytes':extra,'longTraceGrowthAllowanceBytes':2*stress_peak,'measuredWorkingAllocatedPeak':working,'additionalWorkAllowanceBytes':4*2**30,'estimatedFutureBytes':future,'availableAtMeasurement':available,'dockerMemory':info['MemTotal'],'dockerCpus':info['NCPU'],'stress':stress,'recoveryMeasured':recovery_measured,'measurements':rows,'method':'max(57GiB,1.5*(65 measured cases + max(6 health +2 largest task, actual 2 recovery chains) +2 largest stress traces + sampled work peak +4GiB work allowance)+9GiB). Per-case evidence uses max(logical,allocated), so transparent compression does not understate future raw writes. Existing dependencies excluded. Empirical estimate is not an unlimited-output guarantee; 9GiB in-run guard remains.','at':dt.datetime.now(dt.timezone.utc).isoformat()}
assert info['MemTotal']>=result['minimumDockerMemoryBytes']and info['NCPU']>=2
(out/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:result[k]for k in ['qualified','capacityCurrentlySatisfied','minimumFreeBytes','availableAtMeasurement','estimatedFutureBytes']}))
