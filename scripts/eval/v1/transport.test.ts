import {expect,test} from 'bun:test';
import {fatalFaults} from '../container/faults.ts';
import {command} from '../core.ts';

test('历史连接错误不阻止产品重试，预算与未知故障仍致命',()=>{
 expect(fatalFaults(['upstream_connection'])).toEqual([]);
 for(const fault of ['request_budget','evidence_limit','permission_did_not_match_completed_tool','model_mismatch:other','future_unknown_fault'])expect(fatalFaults(['upstream_connection',fault])).toEqual([fault]);
});
test('验收命令明确区分超时器终止和普通非零退出',async()=>{
 const stopped=await command([process.execPath,'-e','await Bun.sleep(10000)'],undefined,true,30);
 expect(stopped.timedOut).toBe(true);expect(stopped.exitCode).not.toBe(0);expect(stopped.durationMs).toBeGreaterThanOrEqual(30);
 const exited=await command([process.execPath,'-e','process.exit(137)'],undefined,true,5000);
 expect(exited.exitCode).toBe(137);expect(exited.timedOut).toBe(false);
 const normal=await command([process.execPath,'-e','console.log("ready")']);
 expect(normal.stdout.trim()).toBe('ready');expect(normal.timedOut).toBe(false);
});
