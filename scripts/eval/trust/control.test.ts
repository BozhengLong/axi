import {test,expect} from 'bun:test';
import {stopState,afterDrain,mayStart,mayGrade} from './control.ts';
import {GradeWindow} from './window.ts';
test('停止新增时仍封存在途；只有可信评分可以继续',()=>{
 for(const trusted of [false,true]){const s=stopState(true,trusted);expect(s.state).toBe('draining');expect(mayStart(s)).toBe(false);expect(mayGrade(s)).toBe(trusted);const drained=afterDrain(s);expect(drained.active).toBe(false);expect(mayStart(drained)).toBe(false);expect(mayGrade(drained)).toBe(trusted)}
});
test('最终与检查点共享绝对截止并保留清理窗口',()=>{
 const end=Date.now()+900000,final=new GradeWindow(end),checkpoint=new GradeWindow(end);
 expect(final.workDeadline).toBe(end-5000);expect(checkpoint.workDeadline).toBe(final.workDeadline);
 expect(()=>new GradeWindow(Date.now()-1).remaining('checkpoint')).toThrow('grade_budget');
});
