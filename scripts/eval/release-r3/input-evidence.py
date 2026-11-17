"""把冻结题面、初态与实际API内容关联；不把终端回显当模型已收到。"""
from pathlib import Path
import base64,hashlib,json,sys
from trace_io import events,sha

def strings(value):
    if isinstance(value,str):
        yield value
        if value.startswith(('{','[')):
            try:parsed=json.loads(value)
            except (ValueError,RecursionError):return
            if isinstance(parsed,(dict,list)):yield from strings(parsed)
    elif isinstance(value,list):
        for x in value:yield from strings(x)
    elif isinstance(value,dict):
        for x in value.values():yield from strings(x)

run=Path(sys.argv[1]).resolve();prompt_path=Path(sys.argv[2]).resolve();prompt=json.loads(prompt_path.read_text())
initial=json.loads((run/'initial-snapshot.json').read_text());entry=initial['files'][prompt['source']]
assert entry['type']=='file'
document=base64.b64decode(entry['data']);assert hashlib.sha256(document).hexdigest()==prompt['sha256'] and document.decode()==prompt['document']
first=None;document_sequences=[]
for e in events(run.parent/'relay'/(run.name+'.jsonl')):
    if e['kind']!='request' or e['data']['path']!='/v1/messages':continue
    data=e['data'];values=list(strings(data['body'].get('messages',[])))
    if first is None:
        first=data['sequence'];assert any(prompt['text'] in value for value in values),'首个模型请求缺少完整任务入口'
    if any(prompt['document'] in value for value in values):document_sequences.append(data['sequence'])
assert first is not None,'没有实际模型请求，不能声称输入已进入API'
if '--require-document' in sys.argv[3:]:assert document_sequences,'完整题面没有出现在后续实际API请求'
print(json.dumps({'qualified':True,'promptHash':sha(prompt_path),'traceHash':sha(run/'trace-manifest.json'),'documentSha256':prompt['sha256'],'firstRequest':first,'completeDocumentSeen':bool(document_sequences),'documentRequestSequences':document_sequences},ensure_ascii=False))
