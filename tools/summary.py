import json,sys,glob,os
d=sys.argv[1]
pl=[];rows=[]
for f in sorted(glob.glob(d+'/*.jsonl')):
    end=None;res=None;last=None;hello=None
    for l in open(f):
        try:m=json.loads(l)
        except:continue
        if m.get('type')=='end' and end is None:end=m
        if m.get('type')=='results':res=m
        if m.get('type')=='obs':last=m
        if m.get('type')=='hello':hello=m
    if not end: rows.append((f,'NO END'));continue
    slot=hello['slot'] if hello else None
    me=[r for r in res['mechs'] if r['id']==slot][0] if res else {}
    pl.append(end['place'])
    rows.append((os.path.basename(f), 'place',end['place'],'kills',end['kills'],'dmg',me.get('damage'),'cubes',me.get('cubes'),'t',last and last['t'],'hp',last and round(last['self']['hp'])))
for r in rows: print(*r)
if pl: print('N',len(pl),'mean place',sum(pl)/len(pl),'score(16-place)',sum(16-p for p in pl)/len(pl))
