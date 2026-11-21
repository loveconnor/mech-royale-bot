import json,sys,math
f=sys.argv[1]; step=int(sys.argv[2]) if len(sys.argv)>2 else 10
t0=float(sys.argv[3]) if len(sys.argv)>3 else 0
L=[json.loads(l) for l in open(f)]
acts={}
for m in L:
    if 'act' in m: acts[m['act'].get('tick')]=(m['act'],m['dt'])
for m in L:
    if m.get('type')!='obs' or m['t']<t0: continue
    o=m; s=o['self']
    if (o['tick']//2)%step: 
        if not any(e['type'] in('kill',) for e in o['events']): continue
    a,dt=acts.get(o['tick'],({},-1))
    ms=[(x['id'],x['kind'][0],round(math.dist(x['pos'][:2],s['pos'][:2])),round(x.get('hp',0))) for x in o['mechs']]
    ev=[e['type']+':'+str(e.get('weapon') or e.get('target') or '')+':'+str(round(e.get('amount',0))) for e in o['events']]
    w=[(x['kind'],x.get('ammo'),round(x.get('charge',0),2)) if x else None for x in s['weapons']]
    lab=a.get('debug',{}).get('label','')
    print(f"{o['t']:6.1f} hp{round(s['hp']):5} e{round(s['energy']):3} pos{[round(v) for v in s['pos']]} {w} z{s['in_zone']} | {lab} | mv{[round(v,1) for v in a.get('move',[0,0])]} f{a.get('fire')} | {ms[:4]} {ev[:5]} dt{dt}")
