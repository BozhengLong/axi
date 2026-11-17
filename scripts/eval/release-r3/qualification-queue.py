"""逐题执行确定性资格，失败时保留现场并停止队列。"""
from pathlib import Path
import datetime as dt,json,subprocess,sys,hashlib,shutil
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
study=Path(sys.argv[1]).resolve();revision=sys.argv[2];tasks=sys.argv[3:]
out=study/('material-queue-'+revision);out.mkdir();(out/'driver.py').write_bytes(Path(__file__).read_bytes())
rows=[]
for task in tasks:
    c7=task.startswith('C7-')
    for kind in (('c7','c7-negative')if c7 else('task','negative')):
        assert shutil.disk_usage(study).free>=9*2**30,'达到磁盘保全底线'
        args=['python3',str(HERE/'qualify-material.py'),kind,str(study),task,revision]+([revision]if 'negative'in kind else[])
        label=task+'-'+kind
        (out/(label+'.command.json')).write_text(json.dumps(args))
        start=dt.datetime.now(dt.timezone.utc).isoformat()
        with(out/(label+'.stdout')).open('xb')as o,(out/(label+'.stderr')).open('xb')as e:r=subprocess.run(args,stdout=o,stderr=e,timeout=14400)
        row={'task':task,'kind':kind,'startedAt':start,'endedAt':dt.datetime.now(dt.timezone.utc).isoformat(),'code':r.returncode};rows.append(row)
        (out/'result.json').write_text(json.dumps({'complete':False,'rows':rows},indent=2));print(json.dumps(row),flush=True)
        if r.returncode:raise SystemExit(r.returncode)
    args=['python3',str(HERE/'audit-material.py'),str(study),task,revision,revision,revision]
    with(out/(task+'-audit.stdout')).open('xb')as o,(out/(task+'-audit.stderr')).open('xb')as e:r=subprocess.run(args,stdout=o,stderr=e,timeout=120)
    if r.returncode:raise SystemExit(r.returncode)
(out/'result.json').write_text(json.dumps({'complete':True,'qualified':True,'rows':rows,'realModelStarts':0},indent=2))
