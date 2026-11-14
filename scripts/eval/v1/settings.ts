import {join} from 'node:path';
import {STORE} from '../core.ts';
export const STUDY=process.env.AXI_V1_STUDY ?? join(STORE,'v1-20261112');
export const IMAGE=process.env.AXI_V1_IMAGE ?? 'sha256:89533abd22cabe73692800a8b7a48ea0849edc6fddd8435cd85898d7938f21cf';
export type TaskId='C7-L'|'C7-O'|'V1-A'|'V1-B'|'V1-C'|'V1-D';
export type Variant='old'|'new'|'claude';
export const RUN_MS=30*60_000, GRADE_MS=15*60_000;
export const schedule=[
 {task:'V1-A',repeat:1,variants:['old','new','claude']},
 {task:'V1-B',repeat:1,variants:['claude','old','new']},
 {task:'V1-A',repeat:2,variants:['new','claude','old']},
 {task:'V1-B',repeat:2,variants:['old','new','claude']},
 {task:'V1-A',repeat:3,variants:['claude','old','new']},
 {task:'V1-B',repeat:3,variants:['new','claude','old']},
] as const;
