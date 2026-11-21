import json,sys,glob,math
from collections import Counter
for f in sys.argv[1:]:
    hits=Counter(); dmg_in=Counter(); rear=0; shots=0; fired_ticks=0; lastammo=None; modes=Counter(); took=[]
    for l in open(f):
        m=json.loads(l)
        if 'act' in m:
            lab=m['act'].get('debug',{}).get('label','')
            modes[lab.split(' ')[0]]+=1
        if m.get('type')!='obs': continue
        s=m['self']
        g=s['weapons'][0]
        if g and g['kind']=='gun':
            if lastammo is not None and g['ammo']<lastammo: shots+=lastammo-g['ammo']
            lastammo=g['ammo']
        for e in m['events']:
            if e['type']=='hit': hits[e['weapon']]+=1
            if e['type']=='damaged':
                dmg_in[e['weapon']]+=e['amount']; rear+=1 if e.get('rear') else 0
            if e['type']=='took': took.append((m['t'],e['kind']))
    print(f.split('/')[-1],'gunshots',shots,'hits',dict(hits),'gun acc %.2f'%(hits['gun']/max(1,shots)),'dmg_in',{k:round(v) for k,v in dmg_in.items()},'rear',rear,'took',took,dict(modes))

def laser(f):
    rel=0;hits=0;prev=0;dmg=0
    for l in open(f):
        m=json.loads(l)
        if m.get('type')!='obs':continue
        for w in m['self']['weapons']:
            if w and w['kind']=='laser':
                if prev>0 and w['charge']==0: rel+=1
                prev=w['charge']
        for e in m['events']:
            if e['type']=='hit' and e['weapon']=='laser': hits+=1; dmg+=e['amount']
    return rel,hits,dmg
import sys
tot=[0,0,0]
for f in sys.argv[1:]:
    r=laser(f); tot=[a+b for a,b in zip(tot,r)]
print('laser releases,hits,dmg',tot)
