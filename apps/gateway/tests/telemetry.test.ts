import { EngineTelemetry, parseEngineMetrics } from '../src/telemetry';

const text=(values:{running?:number;waiting?:number;kv?:number;start?:number;queries?:number;hits?:number})=>[
  '# HELP vllm:num_requests_running Number of requests in model execution batches.','# TYPE vllm:num_requests_running gauge',
  ...(values.running!==undefined?[`vllm:num_requests_running{engine="0",model_name="m"} ${values.running}`]:[]),
  ...(values.waiting!==undefined?[`vllm:num_requests_waiting{engine="0",model_name="m"} ${values.waiting}`]:[]),
  ...(values.kv!==undefined?[`vllm:kv_cache_usage_perc{engine="0",model_name="m"} ${values.kv}`]:[]),
  ...(values.queries!==undefined?[`vllm:prefix_cache_queries_total{engine="0",model_name="m"} ${values.queries}`]:[]),
  ...(values.hits!==undefined?[`vllm:prefix_cache_hits_total{engine="0",model_name="m"} ${values.hits}`]:[]),
  ...(values.start!==undefined?[`process_start_time_seconds ${values.start}`]:[]),
].join('\n')+'\n';

describe('vLLM /metrics parsing',()=>{
  test('vLLM v1 names: running/waiting summed over label sets (engine cores), KV usage = the highest, prefix counters, process start',()=>{
    const parsed=parseEngineMetrics(text({running:3,waiting:1,kv:0.42,queries:1000,hits:600,start:1759990000.5})
      +'vllm:num_requests_waiting{engine="1",model_name="m"} 2\nvllm:kv_cache_usage_perc{engine="1",model_name="m"} 0.9\n');
    expect(parsed).toEqual({running:3,waiting:3,kvUsage:0.9,prefixQueries:1000,prefixHits:600,startTimeSeconds:1759990000.5});
  });
  test('older names are accepted (gpu_cache_usage_perc, counters without _total, gpu_prefix_cache_*); missing ones are null',()=>{
    expect(parseEngineMetrics('vllm:gpu_cache_usage_perc{model_name="m"} 0.5\nvllm:prefix_cache_queries{model_name="m"} 10\nvllm:gpu_prefix_cache_hits_total{model_name="m"} 4\n'))
      .toEqual({running:null,waiting:null,kvUsage:0.5,prefixQueries:10,prefixHits:4,startTimeSeconds:null});
    expect(parseEngineMetrics('garbage\nvllm:num_requests_waiting NaN\n')).toEqual({running:null,waiting:null,kvUsage:null,prefixQueries:null,prefixHits:null,startTimeSeconds:null});
  });
  test('Prometheus/OpenMetrics edge cases: comments, NaN and ±Inf ignored, exemplars and timestamps, "}" and escaped quotes in label values',()=>{
    const parsed=parseEngineMetrics([
      '# HELP vllm:num_requests_waiting Number of requests waiting {to be} processed.','# TYPE vllm:num_requests_waiting gauge',
      'vllm:num_requests_waiting{model_name="a}b",path="x\\"y}"} 3 1700000000000',
      'vllm:num_requests_running{model_name="m"} 2 # {trace_id="abc"} 1.0',
      'vllm:kv_cache_usage_perc{model_name="m"} +Inf','vllm:kv_cache_usage_perc{model_name="n"} NaN','vllm:kv_cache_usage_perc{model_name="o"} 0.4',
      'process_start_time_seconds -Inf','  ','vllm:prefix_cache_hits_total{a="}"}',
    ].join('\n'));
    expect(parsed).toEqual({running:2,waiting:3,kvUsage:0.4,prefixQueries:null,prefixHits:null,startTimeSeconds:null});
  });
});

describe('engine telemetry : a filter only, fail-open when stale',()=>{
  function setup(options:{interval?:number;kvHigh?:number;waitingMax?:number}={}) {
    let now=1_000_000;let body:string|null=text({running:1,waiting:0,kv:0.3,start:100});let fail=false;const events:{restarted:boolean;detectionOff?:boolean;baselineChanged?:boolean}[]=[];const warnings:string[]=[];
    const t=new EngineTelemetry(async()=>{if(fail) throw new Error('down');return body;},
      {intervalMs:options.interval??1000,kvHigh:options.kvHigh??0.95,waitingMax:options.waitingMax??2,now:()=>now,maxSeqs:()=>12,warn:line=>warnings.push(line)},event=>events.push(event));
    return {t,events,warnings,advance:(ms:number)=>{now+=ms;},set:(next:string|null)=>{body=next;},fail:(value:boolean)=>{fail=value;}};
  }
  test('never polled: stale, never blocks',()=>{
    const {t}=setup();
    expect(t.stale()).toBe(true);expect(t.blocked()).toBe(false);
  });
  test('fresh KV usage ≥ 0.95 or waiting > 2 blocks; at the limits it does not',async()=>{
    const s=setup();
    await s.t.poll();expect(s.t.blocked()).toBe(false);
    s.set(text({running:12,waiting:2,kv:0.949,start:100}));await s.t.poll();expect(s.t.blocked()).toBe(false);
    s.set(text({running:12,waiting:3,kv:0.5,start:100}));await s.t.poll();expect(s.t.blocked()).toBe(true);
    s.set(text({running:12,waiting:0,kv:0.95,start:100}));await s.t.poll();expect(s.t.blocked()).toBe(true);
    expect(s.t.metrics()).toMatchObject({stale:false,kvUsage:0.95,waiting:0,running:12,blocked:true,blockedPolls:2});
  });
  test('stale after 3 × the interval without a good poll: the filter is ignored (fail-open) and telemetry_stale counts the episode',async()=>{
    const s=setup();
    s.set(text({running:12,waiting:9,kv:0.99,start:100}));await s.t.poll();expect(s.t.blocked()).toBe(true);
    s.fail(true);await s.t.poll();s.advance(3000);await s.t.poll();
    expect(s.t.blocked()).toBe(true); // 3000 ms = 3 × interval: still fresh
    s.advance(1);expect(s.t.stale()).toBe(true);expect(s.t.blocked()).toBe(false);
    expect(s.t.metrics()).toMatchObject({stale:true,staleEpisodes:1,failedPolls:2});
    s.fail(false);await s.t.poll();expect(s.t.blocked()).toBe(true);expect(s.t.metrics().stale).toBe(false);
    s.set(null);s.advance(3001);await s.t.poll(); // a non-200 /metrics (null) is a failed poll too
    expect(s.t.blocked()).toBe(false);expect(s.t.metrics()).toMatchObject({staleEpisodes:2,failedPolls:3});
  });
  test('credit_model_miss: waiting > 0 on 3 fresh polls in a row counts once per episode (no automatic correction)',async()=>{
    const s=setup();
    s.set(text({running:12,waiting:1,kv:0.5,start:100}));
    for(let i=0;i<5;i++) await s.t.poll();
    expect(s.t.metrics().creditModelMiss).toBe(1);
    s.set(text({running:12,waiting:0,kv:0.5,start:100}));await s.t.poll();
    s.set(text({running:12,waiting:2,kv:0.5,start:100}));for(let i=0;i<2;i++) await s.t.poll();
    expect(s.t.metrics().creditModelMiss).toBe(1);
    await s.t.poll();expect(s.t.metrics()).toMatchObject({creditModelMiss:2,waitingStreak:3});
  });
  test('an engine restart needs two polls in a row with the same new process_start_time_seconds (reported once); without the metric nothing is detected',async()=>{
    const s=setup();
    await s.t.poll();await s.t.poll();expect(s.events.filter(e=>e.restarted)).toHaveLength(0);
    s.set(text({running:0,waiting:0,kv:0,start:200}));await s.t.poll();
    expect(s.t.metrics().restarts).toBe(0); // one poll is not enough
    await s.t.poll();
    expect(s.events.filter(e=>e.restarted)).toHaveLength(1);expect(s.t.metrics().restarts).toBe(1);
    await s.t.poll();expect(s.t.metrics().restarts).toBe(1);
    s.set(text({running:0,waiting:0,kv:0}));await s.t.poll();s.set(text({running:0,waiting:0,kv:0,start:300}));await s.t.poll();await s.t.poll();
    expect(s.t.metrics().restarts).toBe(2); // last known start 200 → 300
  });
  test('several API servers behind one port (different start times answering in turn) are never taken for restarts',async()=>{
    const s=setup();
    for(let i=0;i<6;i++) {s.set(text({running:0,waiting:0,kv:0,start:i%2?100:150}));await s.t.poll();}
    expect(s.t.metrics().restarts).toBe(0);
  });
  test('A,B,B,A with B later: the B,B pair is taken for a restart once, then A (earlier than the current start) reappears and detection is off for good',async()=>{
    const s=setup();
    for(const start of [100,200,200,100]) {s.set(text({running:0,waiting:0,kv:0,start}));await s.t.poll();}
    expect(s.t.metrics()).toMatchObject({restarts:1,restartDetectionDisabled:true});
    expect(s.warnings.filter(w=>/restart detection off/.test(w))).toHaveLength(1);
    for(const start of [100,100,200,200,300,300]) {s.set(text({running:0,waiting:0,kv:0,start}));await s.t.poll();}
    expect(s.t.metrics()).toMatchObject({restarts:1,restartDetectionDisabled:true});
    expect(s.events.filter(e=>e.restarted)).toHaveLength(1);
    expect(s.warnings.filter(w=>/restart detection off/.test(w))).toHaveLength(1); // warned once
  });
  test('A,B,B,A with B earlier: B is never a restart (only a later start time can be) and turns detection off at once',async()=>{
    const s=setup();
    for(const start of [200,100,100,200]) {s.set(text({running:0,waiting:0,kv:0,start}));await s.t.poll();}
    expect(s.t.metrics()).toMatchObject({restarts:0,restartDetectionDisabled:true});
    expect(s.events.filter(e=>e.restarted)).toHaveLength(0);
  });
  test('A,B,A,B,B: an earlier start after any later one (even an unconfirmed candidate) is two processes: off before B,B can count',async()=>{
    const s=setup();
    for(const start of [100,200,100,200,200]) {s.set(text({running:0,waiting:0,kv:0,start}));await s.t.poll();}
    expect(s.t.metrics()).toMatchObject({restarts:0,restartDetectionDisabled:true});
  });
  test('after detection went off, 30 polls in a row with one start time re-arm it with that value as the new baseline',async()=>{
    const s=setup();
    for(const start of [200,100]) {s.set(text({running:0,waiting:0,kv:0,start}));await s.t.poll();}
    expect(s.t.metrics().restartDetectionDisabled).toBe(true);
    expect(s.events.filter(e=>e.detectionOff)).toHaveLength(1); // the pool clears its prefix table once
    s.set(text({running:0,waiting:0,kv:0,start:100}));
    for(let i=0;i<28;i++) await s.t.poll(); // 29 in a row with the poll above
    expect(s.t.metrics().restartDetectionDisabled).toBe(true);
    await s.t.poll();
    expect(s.t.metrics()).toMatchObject({restartDetectionDisabled:false,restarts:0});
    expect(s.warnings.filter(w=>/restart detection back on/.test(w))).toHaveLength(1);
    for(const start of [300,300]) {s.set(text({running:0,waiting:0,kv:0,start}));await s.t.poll();}
    expect(s.t.metrics().restarts).toBe(1);
  });
  test('re-arming with a baseline other than the one before detection went off reports it (the pool clears its prefix table); the same baseline does not',async()=>{
    const s=setup();
    for(const start of [200,100]) {s.set(text({running:0,waiting:0,kv:0,start}));await s.t.poll();}
    s.set(text({running:0,waiting:0,kv:0,start:100}));
    for(let i=0;i<29;i++) await s.t.poll();
    expect(s.t.metrics().restartDetectionDisabled).toBe(false);
    expect(s.events.filter(e=>e.baselineChanged)).toHaveLength(1); // 200 before, 100 now: the process left may be another engine
    const same=setup();
    for(const start of [200,100]) {same.set(text({running:0,waiting:0,kv:0,start}));await same.t.poll();}
    same.set(text({running:0,waiting:0,kv:0,start:200}));
    for(let i=0;i<30;i++) await same.t.poll();
    expect(same.t.metrics().restartDetectionDisabled).toBe(false);
    expect(same.events.filter(e=>e.baselineChanged)).toHaveLength(0);
  });
  test('alternating start times never re-arm detection',async()=>{
    const s=setup();
    for(let i=0;i<80;i++) {s.set(text({running:0,waiting:0,kv:0,start:i%2?100:150}));await s.t.poll();}
    expect(s.t.metrics()).toMatchObject({restartDetectionDisabled:true,restarts:0});
  });
  test('real restarts only move forward: 100 → 300,300 → 400,400 counts two, detection stays on',async()=>{
    const s=setup();
    for(const start of [100,100,300,300,300,400,400]) {s.set(text({running:0,waiting:0,kv:0,start}));await s.t.poll();}
    expect(s.t.metrics()).toMatchObject({restarts:2,restartDetectionDisabled:false});
  });
  test('implausible values (KV usage outside [0, 1], negative counts) are unknown, never a block, and counted',async()=>{
    const s=setup();
    s.set(text({running:1,waiting:0,kv:1.7,start:100}));await s.t.poll();
    expect(s.t.metrics()).toMatchObject({kvUsage:null,blocked:false,implausible:1});
    s.set(text({running:-1,waiting:-3,kv:0.5,start:100}));await s.t.poll();
    expect(s.t.metrics()).toMatchObject({running:null,waiting:null,kvUsage:0.5,implausible:2});
  });
  test('blocked for 10 polls in a row while the engine runs fewer than maxSeqs / 4: one warning per episode (suspect metric)',async()=>{
    const s=setup();
    s.set(text({running:1,waiting:0,kv:0.97,start:100}));
    for(let i=0;i<9;i++) await s.t.poll();
    expect(s.warnings).toHaveLength(0);
    await s.t.poll();await s.t.poll();
    expect(s.warnings).toHaveLength(1);expect(s.warnings[0]).toMatch(/blocked by engine telemetry for 10 polls while running 1 < maxSeqs 12 \/ 4/);
    expect(s.t.metrics().suspectBlocked).toBe(1);
    s.set(text({running:11,waiting:0,kv:0.97,start:100}));for(let i=0;i<12;i++) await s.t.poll(); // really full: no warning
    expect(s.warnings).toHaveLength(1);
  });
  test('the change callback fires when the filter result changes (so the pool re-dispatches), not on every poll',async()=>{
    const s=setup();
    await s.t.poll();await s.t.poll();
    const before=s.events.length;
    s.set(text({running:12,waiting:5,kv:0.5,start:100}));await s.t.poll();await s.t.poll();
    s.set(text({running:1,waiting:0,kv:0.5,start:100}));await s.t.poll();
    expect(s.events.length-before).toBe(2);
  });
  test('polls on its interval once started and stops on stop(); overlapping polls collapse',async()=>{
    let calls=0;let release:(()=>void)|undefined;
    const t=new EngineTelemetry(()=>new Promise(resolve=>{calls++;release=()=>resolve(text({running:0,waiting:0,kv:0,start:1}));}),
      {intervalMs:20,kvHigh:0.95,waitingMax:2,now:Date.now},()=>undefined);
    t.start();await new Promise(r=>setTimeout(r,70));
    expect(calls).toBe(1); // the first poll is still open
    release!();await new Promise(r=>setTimeout(r,50));
    expect(calls).toBeGreaterThan(1);
    t.stop();const after=calls;release!();await new Promise(r=>setTimeout(r,60));
    expect(calls).toBe(after);
  });
});
