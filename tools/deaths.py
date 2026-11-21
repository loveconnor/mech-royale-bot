import json,sys,glob,math
for f in sys.argv[1:]:
    L=[json.loads(l) for l in open(f)]
    obs=[m for m in L if m.get('type')=='obs']
    end=[m for m in L if m.get('type')=='end']
    acts=[m['act'] for m in L if 'act' in m]
    if not obs or not end: continue
    last=obs[-1]; t=last['t']
    dmg={}
    for o in obs:
        if o['t']>t-5:
            for e in o['events']:
                if e['type']=='damaged': dmg[(e['by'],e['weapon'])]=dmg.get((e['by'],e['weapon']),0)+e['amount']
    labs=[a.get('debug',{}).get('label','').split(' ')[0] for a in acts[-50:]]
    from collections import Counter
    ens=[(m['id'],round(m.get('hp',0)),m.get('cubes'),m.get('weapons')) for m in last['mechs'] if m['kind']=='mech']
    print(f.split('/')[-1],'place',end[0]['place'],'t',t,'cubes',last['self']['cubes'],'maxhp',round(last['self']['max_hp']),'dmg5s',{f'{k[0]}:{k[1]}':round(v) for k,v in dmg.items()},'modes',dict(Counter(labs)),'enemies',ens[:4])
