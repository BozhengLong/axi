import assert from 'node:assert/strict';
import {lstatSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {sha} from './source.ts';

// 题面必须来自输入清单，不能猜测文件名或读取未冻结的备用内容。
export function taskPrompt(task:string,taskId:string){
 const manifest=JSON.parse(readFileSync(join(task,'input-manifest.json'),'utf8'));
 const allowed=taskId==='C7-L'?['c7/brief.md']:taskId==='C7-O'?['brief.md']:['eval/task.md','eval/brief.md'];
 const entries=manifest.files.filter((f:any)=>allowed.includes(f.path));
 assert.equal(entries.length,1,'输入清单必须包含唯一公开题面');
 const entry=entries[0];assert.equal(entry.type??'file','file');
 let current=join(task,'initial');assert(lstatSync(current).isDirectory()&&!lstatSync(current).isSymbolicLink());
 for(const part of entry.path.split('/')){current=join(current,part);assert(!lstatSync(current).isSymbolicLink(),'题面路径不能是链接')}
 assert(lstatSync(current).isFile());
 const bytes=readFileSync(current);assert.equal(sha(bytes),entry.sha256,'公开题面与输入清单不符');
 const document=bytes.toString('utf8');assert(document.trim());
 // 三方共用同一单行入口；完整题面保留在工作区，避免行式终端截断多行输入。
 const text=`请先完整读取 ${entry.path} 中的用户任务说明，再按其中全部条款完成修改、验证和交付。该文件是本次任务的完整题面。`;
 assert(!/[\r\n]/.test(text));
 return {task:taskId,source:entry.path,text,document,sha256:entry.sha256};
}
