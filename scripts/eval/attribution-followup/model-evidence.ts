import {readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
// 每次真实任务都核对实际请求；不能只用健康探针的配置代替后续证据。
export function modelEvidence(run:string,id:string,limit=50){
 const events=readFileSync(join(dirname(run),'relay',id+'.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
 const requests=events.filter(e=>e.kind==='request'&&e.data.path==='/v1/messages').map(e=>e.data.body);
 const responses=events.filter(e=>e.kind==='complete_response').map(e=>e.data);
 const partialModels=events.filter(e=>e.kind==='sse'&&e.data.type==='message_start').map(e=>e.data.message.model);
 const countTokens=events.filter(e=>e.kind==='request'&&e.data.path==='/v1/messages/count_tokens').length;
 const valid=requests.length>0&&requests.length<=limit&&requests.every(b=>b.model==='claude-opus-5-5'&&b.output_config?.effort==='medium')&&responses.every(r=>r.model==='claude-opus-5-5')&&partialModels.every(m=>m==='claude-opus-5-5');
 if(!valid)throw Error('实际模型、档位或生成请求上限不符');
 return {valid,generationRequests:requests.length,countTokens,completeResponses:responses.length,model:'claude-opus-5-5',effort:'medium',usage:responses.map(r=>r.usage)};
}
