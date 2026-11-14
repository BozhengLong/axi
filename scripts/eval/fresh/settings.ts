import {join} from 'node:path';
import {STUDY,IMAGE,authorization,read} from '../review/config.ts';
export {STUDY,IMAGE,authorization,read};
export const FRESH=join(STUDY,'fresh');
export const tasks=['V1-C','V1-D'] as const;
export type FreshTask=typeof tasks[number];
export const sources={
 'V1-C':{repo:'quick-lru',commit:'a2190ebdf8e455b95a7138803d274ff5ed57ebcd'},
 'V1-D':{repo:'p-retry',commit:'ac3c4cdb7f015e1f71825e4274e2323a49b615eb'},
};
export const schedule=[
 {task:'V1-C',repeat:1,variants:['old','new','claude']},
 {task:'V1-D',repeat:1,variants:['claude','old','new']},
 {task:'V1-C',repeat:2,variants:['new','claude','old']},
 {task:'V1-D',repeat:2,variants:['old','new','claude']},
 {task:'V1-C',repeat:3,variants:['claude','old','new']},
 {task:'V1-D',repeat:3,variants:['new','claude','old']},
] as const;
export function preparationGate(){
 const a=authorization(),c7=read(join(STUDY,'c7-review.json')),dev=read(join(STUDY,'development-review.json')),f=read(join(STUDY,'release-candidate-freeze.json'));
 if(c7.status!=='passed'||c7.fullDelivery!==2||dev.status!=='passed'||dev.autoFullDelivery!==2||c7.productHash!==f.productHash||f.reviewMode!=='auto')throw Error('新题准备准入未通过');
 return a;
}
