"""核对旧账本、题目模拟轨迹及P3实际源码差异，保留复用依据。"""
from pathlib import Path
import hashlib,json,subprocess,sys,datetime as dt
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent;REPO=HERE.parents[2]
def sha(p):
    with Path(p).open('rb')as f:return hashlib.file_digest(f,'sha256').hexdigest()
def read(p):return json.loads(Path(p).read_text())
def put(p,v):
    with Path(p).open('x')as f:json.dump(v,f,ensure_ascii=False,indent=2);f.write('\n')

if __name__=='__main__':
    old,study=map(lambda x:Path(x).resolve(),sys.argv[1:3]);out=study/'exposure-audit-1';out.mkdir()
    ledger=read(study/'task-reuse-preparation-2/exposure-ledger.json');assert ledger['T02ThroughT20Unclaimed'] and sha(ledger['oldLedger'])==ledger['sha256']
    baseline='dbe7e145d205c21b580d8c2ee2dcf58c408380d8';product='ec5796338c3c62dd56ee6f86fdd93243856cd156'
    diff=subprocess.check_output(['git','diff','--no-ext-diff',baseline,product,'--','src','tests'],cwd=REPO)
    (out/'p3-product-and-tests.diff').write_bytes(diff)
    changed=subprocess.check_output(['git','diff','--name-only',baseline,product,'--','src'],cwd=REPO,text=True).splitlines()
    expected=['src/agent/loop.ts','src/agent/review.ts','src/api/client.ts','src/config.ts','src/log.ts','src/main.ts'];assert sorted(changed)==expected
    rows=[]
    for n in range(2,21):
        task='T'+str(n).zfill(2);traces=[]
        for batch in sorted((old/'tasks'/task).glob('pipeline-*/batch.json')):
            b=read(batch);directory=Path(b['directory'])/'relay';paths=sorted(directory.glob('*.jsonl'))
            # 早期准备失败可以没有注册文件，必须显式留在审计中。
            if not paths:
                traces.append({'batch':str(batch),'batchHash':sha(batch),'registered':False,'note':'no relay registration persisted; not used as positive evidence'})
                continue
            for path in paths:
                with path.open()as f:line=f.readline()
                first=json.loads(line);assert first['kind']=='registered' and first['data']['mock'] is True,(task,path)
                traces.append({'batch':str(batch),'batchHash':sha(batch),'trace':str(path),'sha256':sha(path),'registration':first,'registered':True})
        assert traces and any(t['registered']for t in traces)
        new='U'+str(n).zfill(2);row={'task':new,'oldTask':task,'formalUnclaimed':True,'archivedPipelinesMockOnly':True,'pipelines':traces,'P3ChangeScope':'generic unbounded loop/review, per-call retry, config, trace and CLI reporting; tools, permissions and system prompt unchanged','reuseDefinition':'已有资格材料，未正式作答，未用于本次产品调优；不声称维护者未见题面','approvedForMaterialReuse':True};rows.append(row)
    result={'qualified':True,'at':dt.datetime.now(dt.timezone.utc).isoformat(),'oldLedger':ledger,'baseline':baseline,'product':product,'changedProductFiles':changed,'diff':{'path':str(out/'p3-product-and-tests.diff'),'sha256':sha(out/'p3-product-and-tests.diff')},'rows':rows,'realModelStarts':0,'scope':'records and actual source changes; no claim of mathematically proving an author mental state'}
    put(out/'result.json',result);print(json.dumps({'qualified':True,'tasks':len(rows),'mockArchives':sum(len(r['pipelines'])for r in rows)}))
