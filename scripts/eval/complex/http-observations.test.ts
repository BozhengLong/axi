import {test,expect} from "bun:test";
import {transportSummary} from "./settings.ts";
test("普通 HTTP 限流及连接错误也进入传输摘要",()=>{
 const r=transportSummary([{time:"a",kind:"http_result",data:{status:429}},{time:"b",kind:"http_result",data:{status:403}},{kind:"http_result",data:{status:200}}],["upstream_stream_error"]);
 expect(r.httpErrors).toEqual([{time:"a",status:429},{time:"b",status:403}]);expect(r.issues).toEqual(["upstream_stream_error","http_status:429","http_status:403"]);
});
test("保留重复响应次数，不把无关或损坏记录当 HTTP 错误",()=>{
 const r=transportSummary([{kind:"http_result",data:{status:429}},{kind:"http_result",data:{status:429}},{kind:"sse",data:{status:429}},{kind:"http_result",data:null}]);expect(r.httpErrors).toHaveLength(2);expect(r.issues).toEqual(["http_status:429","http_status:429"]);
});
