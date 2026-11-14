import {GradingIndeterminate} from './status.ts';
export const CLEANUP_RESERVE_MS=5000;
export class GradeWindow {
 readonly workDeadline:number;
 constructor(readonly deadline:number){this.workDeadline=deadline-CLEANUP_RESERVE_MS}
 remaining(stage:string,cleanup=false){const left=(cleanup?this.deadline:this.workDeadline)-Date.now();if(left<=0)throw new GradingIndeterminate('grade_budget',stage);return left}
}
