import json,glob,sys
from collections import Counter
for t in sys.argv[1:]:
    K=[];D=[];W=[];S=[]
    for f in glob.glob(f'logs/{t}/*.jsonl'):
        L=[json.loads(l) for l in open(f)]
        end=[m for m in L if m.get('type')=='end']; res=[m for m in L if m.get('type')=='results']; h=[m for m in L if m.get('type')=='hello']
        if not end or not res: continue
        me=[r for r in res[0]['mechs'] if r['id']==h[0]['slot']][0]
        K.append(end[0]['kills']); D.append(me['damage']); S.append(16-end[0]['place'])
        obs=[m for m in L if m.get('type')=='obs']
        W.append(tuple(sorted(w['kind'] for w in obs[-1]['self']['weapons'] if w)))
    if K: print(t,'n',len(K),'score %.2f'%(sum(S)/len(S)),'kills/match %.2f'%(sum(K)/len(K)),'dmg %.0f'%(sum(D)/len(D)),dict(Counter(W)))
