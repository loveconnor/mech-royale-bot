import json,glob,math,sys
from collections import defaultdict
for t in sys.argv[1:]:
    shots=defaultdict(int);hits=defaultdict(int)
    for f in glob.glob(f'logs/{t}/*.jsonl'):
        L=[json.loads(l) for l in open(f)]
        acts={m['act']['tick']:m['act'] for m in L if 'act' in m}
        prevammo=None
        for m in L:
            if m.get('type')!='obs': continue
            s=m['self']; g=s['weapons'][0]
            if not g or g['kind']!='gun': continue
            lab=acts.get(m['tick'],{}).get('debug',{}).get('label','')
            tid=None
            for tok in lab.split():
                if tok.startswith('t') and tok[1:].isdigit(): tid=int(tok[1:])
            tm=[x for x in m['mechs'] if x['id']==tid]
            if prevammo is not None and g['ammo']<prevammo and tm:
                d=math.dist(tm[0]['pos'][:2],s['pos'][:2]); shots[min(3,int(d//50))]+=prevammo-g['ammo']
            for e in m['events']:
                if e['type']=='hit' and e['weapon']=='gun' and tm and e['target']==tid:
                    d=math.dist(tm[0]['pos'][:2],s['pos'][:2]); hits[min(3,int(d//50))]+=1
            prevammo=g['ammo']
    print(t,' '.join('%d-%d:%.2f(n%d)'%(b*50,b*50+50,hits[b]/max(1,shots[b]),shots[b]) for b in sorted(shots)))
