// token 计数接口不生成回答，不要求携带 output_config。
export function modelSettingsMatch(events:any[],responses:any[]):boolean {
 const requests=events.filter(e=>e.kind==="request").map(e=>e.data);
 const generation=requests.filter(r=>r.path==="/v1/messages");
 return generation.length>0&&requests.every(r=>r.body.model==="claude-opus-5-5")&&generation.every(r=>r.body.output_config?.effort==="medium")&&responses.every(r=>r.model==="claude-opus-5-5");
}

// HTTP 错误不一定作为 SSE error 事件出现。摘要必须同时检查原始 HTTP 响应。
export function transportSummary(events:any[],reported:string[]=[]){
 const httpErrors=events.filter(e=>e.kind==="http_result"&&typeof e.data?.status==="number"&&e.data.status>=400).map(e=>({time:e.time,status:e.data.status}));
 return {issues:[...reported,...httpErrors.map(e=>`http_status:${e.status}`)],httpErrors};
}
