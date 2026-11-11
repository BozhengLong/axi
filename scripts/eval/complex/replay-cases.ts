type R = {kind:string;data:any};
type Expected = {version:number;events:any[];diagnostics:{line:number;code:string}[]};
export type ReplayCase={id:string;text:string;expected?:Expected;exit:number;argv?:string[]};
export function replayCases():ReplayCase[]{
  const log=(r:R)=>JSON.stringify({time:"2026-01-01T00:00:00Z",...r});
  const start:R={kind:"task_start",data:{input:"检查中文🙂",effort:"medium"}},end:R={kind:"task_end",data:{aborted:false}};
  const req=(callId:string,attempt=0):R=>({kind:"request",data:{callId,attempt,body:{}}});
  const resp=(callId:string,content:any[],attempt=0):R=>({kind:"response",data:{callId,attempt,content,stopReason:"end_turn"}});
  const answer=(line:number,callId:string,text:string,thinking="",tools:any[]=[],attempt=0)=>({kind:"response",line,callId,attempt,text,thinking,tools});
  const user=(line=1)=>({kind:"user",line,input:"检查中文🙂"});
  const done=(line:number,aborted=false)=>({kind:"task_end",line,aborted});
  const cases:ReplayCase[]=[];
  function add(id:string,records:R[],events:any[],diagnostics:{line:number;code:string}[]=[]) {cases.push({id,text:records.map(log).join("\n")+"\n",expected:{version:1,events,diagnostics},exit:diagnostics.length?1:0});}
  add("empty",[],[]);
  add("normal",[start,req("a"),resp("a",[{type:"thinking",thinking:"摘要",signature:"opaque-signature"},{type:"text",text:"完成"},{type:"text",text:"🙂"}]),end],[user(),answer(3,"a","完成🙂","摘要"),done(4)]);
  const tool={id:"t1",name:"bash",input:{command:"touch /tmp/axi-replay-sentinel"}},tool2={id:"t2",name:"bash",input:{command:"echo denied"}};
  add("tools",[start,req("tools"),resp("tools",[{type:"text",text:"查看"},{type:"tool_use",...tool},{type:"tool_use",...tool2}]),{kind:"permission",data:{toolUseId:"t1",allowed:true}},{kind:"permission",data:{toolUseId:"t2",allowed:false,reason:"保留文件"}},{kind:"tool_result",data:{tool_use_id:"t1",content:"已记录",is_error:false}},{kind:"tool_result",data:{tool_use_id:"t2",content:"未执行",is_error:true}},end],[user(),answer(3,"tools","查看","",[tool,tool2]),{kind:"permission",line:4,toolUseId:"t1",allowed:true,reason:""},{kind:"permission",line:5,toolUseId:"t2",allowed:false,reason:"保留文件"},{kind:"tool_result",line:6,toolUseId:"t1",content:"已记录",isError:false},{kind:"tool_result",line:7,toolUseId:"t2",content:"未执行",isError:true},done(8)]);
  add("retry",[start,req("r"),{kind:"sse",data:{callId:"r",attempt:0,line:'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"半截错误正文"}}'}},{kind:"request_error",data:{callId:"r",attempt:0,reason:"连接中断"}},req("r",1),resp("r",[{type:"text",text:"重试成功"}],1),end],[user(),{kind:"attempt_error",line:4,callId:"r",attempt:0,reason:"连接中断"},answer(6,"r","重试成功","",[],1),done(7)]);
  add("unfinished",[start,req("pending"),req("tool"),resp("tool",[{type:"tool_use",...tool}])],[user(),answer(4,"tool","","",[tool])],[{line:1,code:"missing_task_end"},{line:2,code:"incomplete_request"},{line:4,code:"missing_tool_result"}]);
  add("duplicate",[start,req("d"),req("d"),resp("d",[{type:"tool_use",...tool}]),req("e"),resp("e",[{type:"tool_use",...tool}]),{kind:"tool_result",data:{tool_use_id:"t1",content:"done",is_error:false}},end],[user(),answer(4,"d","","",[tool]),{kind:"tool_result",line:7,toolUseId:"t1",content:"done",isError:false},done(8)],[{line:3,code:"duplicate_request"},{line:5,code:"incomplete_request"},{line:6,code:"duplicate_tool"}]);
  add("orphan",[{kind:"permission",data:{toolUseId:"unknown",allowed:false}},{kind:"tool_result",data:{tool_use_id:"unknown",content:"x",is_error:true}},resp("missing",[]),end],[],[{line:1,code:"orphan_permission"},{line:2,code:"orphan_result"},{line:3,code:"orphan_completion"},{line:4,code:"orphan_task_end"}]);
  add("invalid",[start,req("bad"),resp("bad",[{type:"thinking",thinking:7}]),{kind:"new_event",data:{}},end],[user(),done(5)],[{line:2,code:"incomplete_request"},{line:3,code:"invalid_record"},{line:4,code:"unknown_kind"}]);
  add("interrupted",[start,req("i"),{kind:"request_error",data:{callId:"i",attempt:0,reason:"aborted"}},{kind:"task_end",data:{aborted:true}},start,req("j"),resp("j",[{type:"text",text:"继续"}]),end],[user(),{kind:"attempt_error",line:3,callId:"i",attempt:0,reason:"aborted"},done(4,true),user(5),answer(7,"j","继续"),done(8)]);
  add("duplicate_result",[start,req("p"),resp("p",[{type:"tool_use",...tool}]),{kind:"permission",data:{toolUseId:"t1",allowed:true}},{kind:"permission",data:{toolUseId:"t1",allowed:true}},{kind:"tool_result",data:{tool_use_id:"t1",content:"ok",is_error:false}},{kind:"tool_result",data:{tool_use_id:"t1",content:"late",is_error:false}},end],[user(),answer(3,"p","","",[tool]),{kind:"permission",line:4,toolUseId:"t1",allowed:true,reason:""},{kind:"tool_result",line:6,toolUseId:"t1",content:"ok",isError:false},done(8)],[{line:5,code:"duplicate_permission"},{line:7,code:"duplicate_result"}]);
  add("duplicate_in_response",[start,req("same-response"),resp("same-response",[{type:"tool_use",...tool},{type:"tool_use",...tool}]),end],[user(),done(4)],[{line:2,code:"incomplete_request"},{line:3,code:"duplicate_tool"}]);
  cases.push({id:"bad_json",text:'\n{bad\r\nnull\n',expected:{version:1,events:[],diagnostics:[{line:2,code:"bad_json"},{line:3,code:"invalid_record"}]},exit:1});
  const normal=cases.find(c=>c.id==="normal")!;cases.push({...normal,id:"crlf",text:"\r\n"+normal.text.trimEnd().replaceAll("\n","\r\n"),expected:{...normal.expected!,events:normal.expected!.events.map(e=>({...e,line:e.line+1}))}});
  cases.push({id:"usage",text:"",argv:["--replay"],exit:2},{id:"missing",text:"",argv:["--replay","/tmp/axi-missing-replay-file"],exit:2},{id:"extra",text:"",argv:["--replay","@input","extra"],exit:2});
  return cases;
}
