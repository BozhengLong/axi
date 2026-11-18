"""只在24份盲评均已记录后揭示版本。"""
from pathlib import Path
from collections import defaultdict
import hashlib,json,sys
study=Path(sys.argv[1]).resolve()
def read(p):return json.loads(p.read_text())
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
frozen=read(study/'manifest.json')
for name,h in frozen['files'].items():assert sha(study/name)==h,name
rubric=read(study/'rubric.json')
answers={p.stem:read(p) for p in (study/'blind').glob('*.json')}
reviews=read(study/'blind-review.json')
assert len(reviews)==24 and len(answers)==24 and set(reviews)==set(answers)
for ident,r in reviews.items():
    assert r['answerHash']==sha(study/'blind'/(ident+'.json'))
    assert r['decision']in ('PASS','N') and r['reason'].strip()
order=read(study/'key.json')['order']
scores=defaultdict(lambda:defaultdict(list))
for row in order:
    ident=row['blind'];case=row['case'];assert answers[ident]['case']==case
    scores[row['arm']][case].append(reviews[ident]['decision'])
for arm,group in scores.items():
    assert set(group)==set(rubric) and all(len(v)==2 for v in group.values())
counts={a:sum(x=='PASS' for v in g.values()for x in v)for a,g in scores.items()}
result={'scores':scores,'passed':counts,'replayGatePassed':counts['experiment']==12,'reviewSha256':sha(study/'blind-review.json'),'manifestSha256':sha(study/'manifest.json'),'holdoutsAuthorizedToStart':counts['experiment']==12}
with(study/'replay-decision.json').open('x')as f:json.dump(result,f,ensure_ascii=False,indent=2);f.write('\n')
print(json.dumps(result,ensure_ascii=False))
