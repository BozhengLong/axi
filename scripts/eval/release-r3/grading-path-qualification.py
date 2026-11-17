"""核验实际共享评分路径可修复，产品、执行、原始输入和控制器仍不可变。"""
from pathlib import Path
import ast,hashlib,importlib.util,json,sys
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent;study=Path(sys.argv[1]).resolve();out=study/sys.argv[2];out.mkdir()
spec=importlib.util.spec_from_file_location('gateway',HERE/'controller-gateway.py');gateway=importlib.util.module_from_spec(spec);spec.loader.exec_module(gateway)
before=(study/'repair-path-defect-1/controller-gateway-before.py').read_text();after=(HERE/'controller-gateway.py').read_text()
x=ast.parse(before);y=ast.parse(after)
for tree in (x,y):tree.body=[node for node in tree.body if not isinstance(node,ast.FunctionDef)or node.name!='grading_change']
assert ast.dump(x)==ast.dump(y),'修复影响了其他控制器入口'
rows=[]
for repeat in range(1,6):
    for root in (HERE,HERE.parent/'release-r2'):
        for name in ('grade-artifact.py','observations.py','bun-report.py','artifact-policy.py','path_patterns.py','sandbox.py','restore.mjs','reporters/node.mjs'):
            assert gateway.grading_change(study,root/name);rows.append({'root':root.name,'path':name,'allowed':True,'repeat':repeat})
        for name in ('controller.py','controller-gateway.py','core.ts','relay.ts','formal-grade.py','execute-subject.ts','capture.mjs','inputs.py','policy.ts','guardian.py'):
            assert not gateway.grading_change(study,root/name);rows.append({'root':root.name,'path':name,'allowed':False,'repeat':repeat})
    for path in (HERE.parents[2]/'src/agent/loop.ts',study/'tasks/U01/input-manifest.json',study/'tasks/U01/initial/eval/task.md'):
        assert not gateway.grading_change(study,path);rows.append({'path':str(path),'allowed':False,'repeat':repeat})
(out/'controller-gateway-before.py').write_text(before);(out/'controller-gateway-after.py').write_text(after)
result={'qualified':True,'mockOnly':True,'repeats':5,'checks':len(rows),'sourceSha256':hashlib.sha256(after.encode()).hexdigest(),'onlyGradingChangeFunctionModified':True,'rows':rows}
(out/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'qualified':True,'checks':len(rows)}))
