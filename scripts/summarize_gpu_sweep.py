"""Summarize a bench-jev-gemma.ts sweep: per-level requests + pod nvidia-smi CSV (UTC window join) + vLLM /metrics scrapes.
usage: python3 -I scripts/summarize_gpu_sweep.py reports/gpu-sweep/<date>"""
import json, csv, sys, math, os
from datetime import datetime, timezone, timedelta
d = sys.argv[1]
def pct(v, p):
    if not v: return None
    s = sorted(v); return s[min(len(s)-1, max(0, math.ceil(p/100*len(s))-1))]
def mean(v): return round(sum(v)/len(v), 1) if v else None
def num(x): return float(x.strip().split()[0])
out = {}
for model in ['gemma-4-e4b-fp8', 'gemma-4-26b-a4b-nvfp4']:
    sw = json.load(open(f'{d}/sweep-{model}.private.json'))
    rows = []
    with open(f'{d}/gpu-{model}.private.csv') as f:
        r = csv.reader(f); next(r)
        for row in r:
            if len(row) < 7: continue
            t = datetime.strptime(row[0].strip(), '%Y/%m/%d %H:%M:%S.%f').replace(tzinfo=timezone.utc)
            rows.append(dict(t=t, gpu=num(row[1]), mem=num(row[2]), used=num(row[3]), total=num(row[4]), power=num(row[5]), sm=num(row[6])))
    idle = [g for g in rows if g['gpu'] == 0]
    levels = {}
    for res in sw['results']:
        start = datetime.fromisoformat(res['startedAt'].replace('Z', '+00:00')); end = start + timedelta(milliseconds=res['durationMs'])
        g = [x for x in rows if start <= x['t'] <= end]
        req = res['requests']; ok = [q for q in req if q['ok']]
        inwin = [q for q in ok if q['endMs'] <= res['durationMs']]
        sc = res['scrapes']; win = [s for s in sc if s['t'] <= res['durationMs']]
        def series(k): return [s['values'][k] for s in win if k in s['values']]
        kvk = 'kv_cache_usage_perc' if any('kv_cache_usage_perc' in s['values'] for s in sc) else 'gpu_cache_usage_perc'
        kv = [100*x for x in series(kvk)]
        first, last = sc[0]['values'], sc[-1]['values']
        dq = last.get('prefix_cache_queries_total', 0) - first.get('prefix_cache_queries_total', 0)
        dh = last.get('prefix_cache_hits_total', 0) - first.get('prefix_cache_hits_total', 0)
        levels[res['level']] = dict(
            requests=len(req), ok=len(ok), completedIn60s=len(inwin), schemaValidPct=round(100*sum(q['schemaValid'] for q in req)/len(req), 1),
            latencyMs=dict(p50=pct([q['totalMs'] for q in ok], 50), p95=pct([q['totalMs'] for q in ok], 95)),
            ttftMs=dict(p50=pct([q['ttftMs'] for q in ok if q['ttftMs'] is not None], 50), p95=pct([q['ttftMs'] for q in ok if q['ttftMs'] is not None], 95)),
            reqPerS=round(len(inwin)/(res['durationMs']/1000), 2), outTokPerS=round(sum(q['completionTokens'] or 0 for q in inwin)/(res['durationMs']/1000), 1),
            outTokPerReqMean=mean([q['completionTokens'] or 0 for q in ok]), promptTokMean=mean([q['promptTokens'] or 0 for q in ok]),
            gpuSamples=len(g), gpuUtilMean=mean([x['gpu'] for x in g]), memBwUtilMean=mean([x['mem'] for x in g]),
            powerMean=mean([x['power'] for x in g]), powerMax=max(x['power'] for x in g), smClockMean=mean([x['sm'] for x in g]), smClockMin=min(x['sm'] for x in g),
            vramUsedMiB=dict(mean=mean([x['used'] for x in g]), max=max(x['used'] for x in g)), vramTotalMiB=g[0]['total'],
            kvCachePct=dict(mean=mean(kv), max=round(max(kv), 1) if kv else None), kvMetric=kvk,
            running=dict(mean=mean(series('num_requests_running')), max=max(series('num_requests_running') or [None])),
            waiting=dict(mean=mean(series('num_requests_waiting')), max=max(series('num_requests_waiting') or [None])),
            preemptions=last.get('num_preemptions_total', 0) - first.get('num_preemptions_total', 0),
            prefixHitPct=round(100*dh/dq, 1) if dq else None, scrapes=len(win), drainMs=res['drainMs'])
    out[model] = dict(levels=levels, idle=dict(samples=len(idle), powerMean=mean([x['power'] for x in idle]), vramMiB=max([x['used'] for x in idle] or [None])))
json.dump(out, open(f'{d}/summary.private.json', 'w'), indent=1)
os.chmod(f'{d}/summary.private.json', 0o600)
print(json.dumps(out, indent=1))
