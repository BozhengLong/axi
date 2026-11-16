"""从已经完成的证据构建正式准入文件；缺项时不写release-manifest。"""
from pathlib import Path
import datetime as dt,hashlib,importlib.util,json,os,subprocess,sys
sys.dont_write_bytecode=True
from controller import digest,slots
from inputs import git_identity,verify_initial
HERE=Path(__file__).resolve().parent;REPO=HERE.parents[2]

def read(path):return json.loads(Path(path).read_text())
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def put(path,value):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('x')as f:json.dump(value,f,ensure_ascii=False,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
    path.chmod(0o600)

def build(study,plan_path):
    study=Path(study).resolve();plan=read(plan_path);out=study/'admission';out.mkdir()
    assert not(study/'release-manifest.json').exists() and read(study/'stage.json')['T1']is None
    assert dt.datetime.now(dt.timezone.utc)<dt.datetime.fromisoformat(read(study/'authorization.json')['preparationDeadline'])
    def bound(path):
        path=Path(path).resolve();assert path.is_relative_to(study)and path.is_file();return {'path':str(path.relative_to(study)),'sha256':sha(path)}
    def proof(relative):
        p=study/relative;value=read(p);assert value['qualified']is True,relative;return bound(p)
    qualified_pipelines=[];task_rows=[];c7_rows=[];facility=set()
    for root in [HERE,REPO/'src']:
        facility.update(p for p in root.rglob('*')if p.is_file()and p.suffix in ('.py','.ts','.mjs','.cjs')and '__pycache__'not in p.parts)
    for name in ['core.ts','adapters.ts','trace.ts','v1/adapter.ts','v1/preview.ts']:facility.add(REPO/'scripts/eval'/name)
    for name in ['package.json','bun.lock','tsconfig.json']:facility.add(REPO/name)
    rows=plan['tasks'];assert [r['id']for r in rows]==[f'T{i:02}'for i in range(1,21)]
    for row in rows+plan['c7Tasks']+[plan['healthTask']]:
        task_id=row['id'];task=study/('health'if task_id=='health'else ('c7/'if task_id.startswith('C7-')else'tasks/')+task_id)
        manifest=read(task/'input-manifest.json');profile=read(task/'qualification-profile.json');verify_initial(task/'initial',manifest)
        for p in task.iterdir():
            if p.name in ('qualification-profile.json','grading-profile.json','negative-controls.json')or p.name.endswith('-patch.json'):facility.add(p)
        facility.update(p for p in(task/'qualification-material').rglob('*')if p.is_file())
        if task_id!='health':
            audit=read(task/row['audit']);assert all(audit[k]is True for k in ('sourceArchivesVerified','taskInputsUnchanged','negativeClassificationChecked'))
            positive=read(task/audit['referenceQualification']/'results.json');negative=read(task/audit['negativeQualification']/'results.json')
            assert positive['qualified']and positive['facilityStable']and negative['qualified']and negative['facilityStable']
            assert len(positive['rows'])==(len(profile['references'])+2)*5 and all(r['passed']and r['elapsedSeconds']<=720 for r in positive['rows'])
            assert len(negative['rows'])==audit['negativeCases']and all(r['qualified']for r in negative['rows'])
            for directory in [task/audit['referenceQualification'],task/audit['negativeQualification']]:
                for path,checksum in read(directory/'facility.json').items():
                    assert sha(directory/'facility-source'/checksum)==checksum
                    if Path(path).is_relative_to(task):assert sha(path)==checksum
            products=['v1']if task_id.startswith('C7-')else['v0','v1','claude']
        else:products=[]
        pipeline_bindings=[]
        for product in products:
            d=task/('pipeline-'+product+'-'+plan['pipelineRevision']);result=read(d/'result.json');verification=read(d/'facility-verification.json');f=read(d/'facility.json')
            assert result['qualified']and result['mockOnly']and result['task']==task_id and result['product']==product and result['gradingMs']<=720000
            assert verification['stable']and verification['sourceHash']==f['sourceHash']
            for record in f['records']:
                assert sha(record['path'])==record['sha256']and sha(d/'facility-source'/record['sha256'])==record['sha256'],'最终CLI资格后设施改变'
            assert read(d/'controller-review.json')['classification']=='PASS'
            pipeline_bindings.append(bound(d/'result.json'));qualified_pipelines.append({'task':task_id,'product':product,'result':bound(d/'result.json'),'verification':bound(d/'facility-verification.json')})
        files=[bound(task/'input-manifest.json')]
        for entry in manifest['files']:
            if entry.get('type','file')=='file':files.append(bound(task/'initial'/entry['path']))
        binding={'id':task_id,'admitted':True,'inputManifest':bound(task/'input-manifest.json'),'initial':str((task/'initial').relative_to(study)),'gitIdentity':git_identity(task/'initial'),'files':files,'pipelines':pipeline_bindings}
        path=out/'bindings'/(task_id+'.json');put(path,binding)
        entry={**row,'admitted':True,'manifestHash':digest(binding),'binding':bound(path)}
        if task_id=='health':health=entry
        elif task_id.startswith('C7-'):c7_rows.append(entry)
        else:
            assert entry['repository']==manifest['repository']and entry['category']==manifest['category']
            assert entry['userDirty']==bool(manifest['userDirty'])
            if entry['productionDirty']:assert any(not x.startswith('notes/')for x in manifest['userDirty'])
            if entry['asyncBehavior']:assert entry.get('asyncWitness')and all((task/'initial'/x).is_file()for x in entry['asyncWitness'])
            task_rows.append(entry)
    assert len(qualified_pipelines)==62
    pipeline=out/'pipeline.json';put(pipeline,{'qualified':True,'taskCases':60,'c7Cases':2,'mockOnly':True,'rows':qualified_pipelines})
    task_proof=out/'task-package.json';audits=[read(study/'tasks'/r['id']/r['audit'])for r in rows]
    assert sum(a['referenceCases']for a in audits)==400
    put(task_proof,{'qualified':True,'referenceCases':300,'counterfactualCases':100,'negativeCases':sum(a['negativeCases']for a in audits),'tasks':[bound(study/'tasks'/r['id']/r['audit'])for r in rows]})
    c7_proof=out/'c7.json';put(c7_proof,{'qualified':True,'referenceAndCounterfactualCases':30,'negativeCases':30,'audits':[bound(study/'c7'/r['id']/r['audit'])for r in plan['c7Tasks']],'regressionQualification':proof(plan['c7RegressionProof'])})
    for tree in ['v0-runtime','v1-runtime']:
        facility.update(p for p in(study/tree).rglob('*')if p.is_file()and 'node_modules'not in p.parts)
    facility.update(study/name for name in ['candidate-source.json','v0-source.json','toolchain/verification.json'])
    archive=out/'facility-source';archive.mkdir();index={'schema':1,'files':[]}
    for path in sorted(facility):
        assert path.is_file()and not path.is_symlink();checksum=sha(path);a=archive/checksum
        if not a.exists():a.write_bytes(path.read_bytes());a.chmod(0o600)
        index['files'].append({'path':str(path.resolve()),'sha256':checksum,'archive':str(a.relative_to(study))})
    index_path=out/'facility-index.json';put(index_path,index)
    git=lambda args:subprocess.run(['git',*args],cwd=REPO,check=True,capture_output=True,text=True).stdout.strip()
    assert not git(['status','--porcelain']), '冻结前工作树必须提交'
    commit=git(['rev-parse','HEAD']);branch=git(['branch','--show-current']);remote=git(['ls-remote','origin','refs/heads/'+branch]).split()[0];assert remote==commit
    candidate=read(study/'candidate.json');identity={'candidate':'dbe7e145d205c21b580d8c2ee2dcf58c408380d8','sourceHash':'14be06a50a8163d4461c1d6e6a498ede412b13dc927f80fa4cf323446a552855','v0':'963704be97150e268edd3fda484d68e0a18a1f8b','image':'sha256:2c28b2b381ad0647f6a95afbd781e0d27e06a892fd40a164ac0dcb753fb92ba1','model':'claude-opus-5-5','claude':'2.1.322'}
    proofs={key:proof(path)for key,path in plan['proofs'].items()};proofs.update(pipeline=bound(pipeline),taskPackage=bound(task_proof),c7=bound(c7_proof));assert set(proofs)=={'engineering','taskPackage','c7','controller','pipeline','capture','dependencies','resourcePolicy','evidenceAudit'}
    manifest={'schema':1,'T0':read(study/'authorization.json')['T0'],'identities':identity,'qualificationComplete':True,'commit':commit,'remoteCommit':remote,'branch':branch,'tasks':task_rows,'c7Tasks':c7_rows,'healthTask':health,'proofs':proofs,'facilityIndex':bound(index_path),'facilityHash':digest(index),'engineeringHash':proofs['engineering']['sha256'],'c7QualificationHash':proofs['c7']['sha256'],'controllerQualificationHash':proofs['controller']['sha256'],'dependencyHash':proofs['dependencies']['sha256'],'evidenceAuditHash':proofs['evidenceAudit']['sha256']}
    spec=importlib.util.spec_from_file_location('gateway',HERE/'controller-gateway.py');gateway=importlib.util.module_from_spec(spec);spec.loader.exec_module(gateway);gateway.verify_admission(study,manifest);gateway.resources(study,manifest)
    put(study/'release-manifest.json',manifest);return {'qualified':True,'commit':commit,'facilityHash':manifest['facilityHash'],'tasks':20,'pipelines':62}

if __name__=='__main__':print(json.dumps(build(sys.argv[1],sys.argv[2])))
