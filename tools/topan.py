import json,sys
from collections import defaultdict,Counter
L=[]
for f in sys.argv[1:]:
    for x in open(f):
        x=x.strip()
        if x:
            try:L.append(json.loads(x))
            except:pass
# group by header
matches=[];cur=None
for m in L:
    if m.get('type')=='header': cur={'h':m,'ev':[],'res':None,'frames':{}}; matches.append(cur)
    elif cur is None: continue
    elif m.get('type')=='result': cur['res']=m
    elif 't' in m and 'm' in m:
        if m['t'] not in cur['frames']:
            cur['frames'][m['t']]=m
            cur['ev']+=m.get('ev',[])
seen=set();A=defaultdict(lambda:defaultdict(list))
for mt in matches:
    h=mt['h']; r=mt['res']
    if not r or not h.get('showdown'): continue
    key=(h['seed'],h['showdown']['id'],h['showdown']['match'])
    if key in seen: continue
    seen.add(key)
    names={m['id']:m['name'] for m in h['mechs']}
    fires=Counter(); laserhits=Counter(); lasers=Counter(); charges=defaultdict(list); hits=Counter()
    for e in mt['ev']:
        if e['e']=='fire': fires[(e['id'],e.get('w'))]+=1
        if e['e']=='laser': lasers[e['id']]+=1; laserhits[e['id']]+= bool(e.get('hits'))
        if e['e']=='charge': charges[e['id']].append(e['dur'])
        if e['e']=='hit' and e.get('w')=='gun' and e['src']<16: hits[e['src']]+=1
    for m in r['mechs']:
        a=A[m['name']]
        for k in ['place','kills','damage_dealt','damage_taken','cubes_max','first_weapon_t','death_t']:
            if m.get(k) is not None: a[k].append(m[k])
        a['loadout'].append('+'.join(x for x in m.get('loadout',[]) if x))
        a['ups'].extend(m.get('upgrades',[]))
        i=m['id']
        a['gunacc'].append(hits[i]/max(1,fires[(i,'gun')]))
        a['laseracc'].append(laserhits[i]/max(1,lasers[i]))
        a['dmgw'].append(m.get('damage_by_weapon',{}))
print('matches',len(seen))
avg=lambda v: sum(v)/len(v) if v else float('nan')
rows=sorted(A.items(), key=lambda x: avg(x[1]['place']))
for nm,a in rows:
    print(f"{nm[:16]:16} n{len(a['place'])} place {avg(a['place']):4.1f} kills {avg(a['kills']):.1f} dealt {avg(a['damage_dealt']):5.0f} taken {avg(a['damage_taken']):5.0f} cubes {avg(a['cubes_max']):4.1f} 1stW {avg(a['first_weapon_t']):5.1f} gunacc {avg(a['gunacc']):.2f} lasacc {avg(a['laseracc']):.2f} load {Counter(a['loadout']).most_common(2)}")
if len(sys.argv)>0:
    for nm in ['IT_Professionals','kyoto-max','67','TigerTown27','not even close','doni']:
        if nm in A: print(nm,'ups',Counter(A[nm]['ups']).most_common(8))
