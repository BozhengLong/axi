import {join,dirname} from 'node:path';
import {authorization,assertGradingAllowed,read} from './config.ts';
import {verifyExecution} from '../stable/execution.ts';
// 阻断真实评分时仍可验证设施。资格通道只接收宿主创建的模拟批次，不能放行真实产物。
export function assertMayGrade(run:string,qualification:boolean){
 if(!qualification){assertGradingAllowed(verifyExecution(run).task);return}
 authorization();const manifest=read(join(dirname(run),'manifest.json'));
 if(manifest.suite!=='trust-pipeline-mock'||manifest.mockOnly!==true)throw Error('资格评分拒绝非模拟产物');
}
