// 保留UTF-8和行边界；EOF允许完整JSON末行，拒绝半截JSON。
export class JsonLines {
  private decoder = new TextDecoder('utf-8', {fatal:true});
  private buffer = '';
  constructor(private accept: (value: any) => void, readonly maxLineBytes=64*1024*1024) {}
  write(bytes: Uint8Array): void {
    this.feed(this.decoder.decode(bytes,{stream:true}));
  }
  private feed(text:string): void {
    this.buffer+=text;
    for(let i;(i=this.buffer.indexOf('\n'))>=0;){
      const line=this.buffer.slice(0,i);this.buffer=this.buffer.slice(i+1);
      if(Buffer.byteLength(line)>this.maxLineBytes)throw Error('JSONL单条记录超过声明的解析窗口');
      if(line.trim())this.accept(JSON.parse(line));
    }
    if(Buffer.byteLength(this.buffer)>this.maxLineBytes)throw Error('JSONL单条记录超过声明的解析窗口');
  }
  finish():void {
    this.feed(this.decoder.decode());
    if(this.buffer.trim())this.accept(JSON.parse(this.buffer));
    this.buffer='';
  }
}
