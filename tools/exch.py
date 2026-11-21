import json,glob,sys
for t in sys.argv[1:]:
    dealt=0;taken=0;mech_dealt=0
    for f in glob.glob(f'logs/{t}/*.jsonl'):
        for l in open(f):
            m=json.loads(l)
            if m.get('type')!='obs':continue
            for e in m['events']:
                if e['type']=='hit':
                    dealt+=e['amount']
                    if e['target']<16: mech_dealt+=e['amount']
                if e['type']=='damaged' and e['weapon'] not in('zone','npc'): taken+=e['amount']
    print(t,'mech_dealt',round(mech_dealt),'taken(mech)',round(taken),'ratio %.2f'%(mech_dealt/max(1,taken)))
