import {test,expect} from 'bun:test';
import {JsonLines} from './json-lines.ts';
test('JSONL跨UTF8边界、无末尾换行均保留完整记录，半截或超界不接受',()=>{
 const values:any[]=[];const parser=new JsonLines(v=>values.push(v));
 for(const byte of Buffer.from('{"text":"中文🙂"}\n{"tail":true}'))parser.write(Uint8Array.of(byte));
 parser.finish();expect(values).toEqual([{text:'中文🙂'},{tail:true}]);
 const broken=new JsonLines(()=>{throw Error('半截不能产生事件')});broken.write(Buffer.from('{"tail":'));expect(()=>broken.finish()).toThrow();
 const utf=new JsonLines(()=>{});utf.write(Uint8Array.of(0xe4));expect(()=>utf.finish()).toThrow();
 const bounded=new JsonLines(()=>{},4);expect(()=>bounded.write(Buffer.from('12345'))).toThrow('解析窗口');
});
