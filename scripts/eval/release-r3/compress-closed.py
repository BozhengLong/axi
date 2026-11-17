"""仅透明压缩已关闭证据；逐文件保持可读字节、权限及mtime，不删除Trace。"""
from pathlib import Path
import datetime as dt,hashlib,json,os,stat,subprocess,sys,time
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
from trace_io import verify_run
study=Path(sys.argv[1]).resolve();revision=sys.argv[2];out=study/('closed-compression-'+revision);out.mkdir()
sha=lambda p:hashlib.file_digest(Path(p).open('rb'),'sha256').hexdigest()
roots=[];runs=[];files=set()
for root in [study/'tasks',study/'c7']:
    for result in root.glob('*/qualification-*/results.json'):
        if json.loads(result.read_text()).get('qualified'):roots.append(result.parent)
    for result in root.glob('*/negative-qualification-*/results.json'):
        if json.loads(result.read_text()).get('qualified'):roots.append(result.parent)
for manifest in (study/'runtime').glob('*/*/trace-manifest.json'):
    info=json.loads(manifest.read_text())
    if info.get('status')!='complete_observable':continue
    run=manifest.parent;verify_run(run);runs.append(run)
    for entry in info['files']:files.add((run/entry['path']).resolve())
for root in roots:
    for base,dirs,names in os.walk(root,followlinks=False):
        dirs[:]=[d for d in dirs if not(Path(base)/d).is_symlink()]
        files.update(Path(base)/name for name in names)
(out/'scope.json').write_text(json.dumps({'roots':[str(p)for p in roots],'closedRuns':[str(p)for p in runs],'driverSha256':sha(Path(__file__))},indent=2)+'\n')
processed=compressed=saved=0;start=time.time();free_before=os.statvfs(study).f_bavail*os.statvfs(study).f_frsize
with(out/'files.jsonl').open('x')as log:
    for p in sorted(files):
        assert p.is_relative_to(study)
        a=p.lstat()
        if not stat.S_ISREG(a.st_mode)or a.st_nlink!=1 or a.st_size<65536 or a.st_flags&32:continue
        before=sha(p);temp=p.with_name(p.name+'.axi-compress-tmp');assert not temp.exists()
        r=subprocess.run(['/usr/bin/ditto','--hfsCompression','--noclone',str(p),str(temp)],capture_output=True,timeout=180)
        assert r.returncode==0,r.stderr.decode()
        b=temp.lstat();assert sha(temp)==before and (a.st_mode,a.st_size,a.st_mtime_ns)==(b.st_mode,b.st_size,b.st_mtime_ns)
        assert (p.lstat().st_ino,p.lstat().st_mtime_ns)==(a.st_ino,a.st_mtime_ns) and sha(p)==before,'闭合文件出现并发写入'
        gain=a.st_blocks*512-b.st_blocks*512
        if gain>0:os.replace(temp,p);compressed+=1;saved+=gain
        else:temp.unlink()
        assert sha(p)==before
        log.write(json.dumps({'path':str(p.relative_to(study)),'sha256':before,'bytes':a.st_size,'mode':stat.S_IMODE(a.st_mode),'mtimeNs':a.st_mtime_ns,'beforeAllocated':a.st_blocks*512,'afterAllocated':p.stat().st_blocks*512})+'\n');log.flush();processed+=1
        if processed%100==0:print(json.dumps({'processed':processed,'savedGiB':round(saved/2**30,2)}),flush=True)
for run in runs:verify_run(run)
free_after=os.statvfs(study).f_bavail*os.statvfs(study).f_frsize
result={'qualified':True,'processedFiles':processed,'compressedFiles':compressed,'savedFileAllocatedBytes':saved,'freeBefore':free_before,'freeAfter':free_after,'allBytesModesMtimesPreserved':True,'closedTraceManifestsReverified':len(runs),'seconds':time.time()-start,'at':dt.datetime.now(dt.timezone.utc).isoformat(),'scope':'closed qualification results and sealed complete runtime traces only; no product, current input, dependency, incomplete trace or backup changes'}
(out/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result),flush=True)
