import json,sys,math,array
sys.path.insert(0,'tools')
t=array.array('h'); t.frombytes(open('kit/arena/v2/terrain.i16','rb').read())
def ground(x,y):
    i=int(round(x+513)); j=int(round(y+334)); i=max(0,min(1069,i)); j=max(0,min(723,j)); return t[j*1070+i]/100
L=[]
for f in sys.argv[1:]:
    for x in open(f):
        x=x.strip()
        if x:
            try:L.append(json.loads(x))
            except:pass
matches=[];cur=None
for m in L:
    if m.get('type')=='header': cur={'h':m,'f':{}}; matches.append(cur)
    elif cur is not None and 't' in m and 'm' in m: cur['f'][m['t']]=m
from collections import defaultdict
agg=defaultdict(lambda: defaultdict(float))
for mt in matches:
    h=mt['h']; fr=[mt['f'][k] for k in sorted(mt['f'])]
    if len(fr)<500 or not h.get('showdown'): continue
    lastT={}
    for f in fr:
        for r in f['m']: lastT[r[0]]=f['t']
    order=sorted(lastT,key=lambda k:-lastT[k])
    for f in fr:
        zc=f['z']
        for r in f['m']:
            id_,x,y,z,yaw,pitch,hp,en,flags,cubes,mhp,s0,s1=r[:13]
            nm=h['mechs'][id_]['name']
            a=agg[nm]
            a['n']+=1
            a['roof']+= z>ground(x,y)+3
            a['boost']+= bool(flags&2)
            a['air']+= not (flags&1)
            a['charge']+= bool(flags&4)
            a['zdist']+= math.dist((x,y),zc[:2])/max(zc[2],1)
    for k,id_ in enumerate(order):
        nm=h['mechs'][id_]['name']; agg[nm]['place']+=k+1; agg[nm]['m']+=1
for nm,a in sorted(agg.items(), key=lambda x:x[1]['place']/max(1,x[1]['m'])):
    n=a['n']
    print(nm[:18].ljust(18),'matches',int(a['m']),'avgplace %.1f'%(a['place']/max(1,a['m'])),'roof %.2f boost %.2f air %.2f charge %.2f zfrac %.2f'%(a['roof']/n,a['boost']/n,a['air']/n,a['charge']/n,a['zdist']/n))
