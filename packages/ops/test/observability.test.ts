import { createServer } from 'node:net';
import { Counter, Gauge, Histogram, Registry, createMetricsRegistry, parseExposition } from '../src/metrics';
import { createLog } from '../src/log';
import { metricsPort, PROM_CONTENT_TYPE, startMetricsListener } from '../src/http-metrics';

describe('standard Prometheus collectors',()=>{
  test('genuine SDK owns counters, buckets, gauges and escaping; parser reads exported text',async()=>{
    const registry=new Registry();
    const counter=new Counter({name:'ptr_x_total',help:'X.',labelNames:['reason'],registers:[registry]});
    counter.inc({reason:'queue_full'});counter.inc({reason:'queue_full'},2);counter.inc({reason:'a"b\\c\nd'});
    const histogram=new Histogram({name:'ptr_z_seconds',help:'Z.',buckets:[0.5,1],registers:[registry]});
    histogram.observe(0.2);histogram.observe(0.7);histogram.observe(3);
    new Gauge({name:'ptr_y',help:'Y.',registers:[registry]}).set(1.5);
    new Counter({name:'ptr_empty_total',help:'No samples yet.',labelNames:['reason'],registers:[registry]});
    const text=await registry.metrics();
    expect(registry.getSingleMetric('ptr_x_total')).toBeInstanceOf(Counter);
    expect(registry.getSingleMetric('ptr_z_seconds')).toBeInstanceOf(Histogram);
    expect(text.endsWith('\n')).toBe(true);expect(text).toContain('ptr_x_total{reason="queue_full"} 3');
    expect(text).toContain('# TYPE ptr_empty_total counter');
    const parsed=parseExposition(text);
    expect(parsed.samples.find(s=>s.name==='ptr_x_total'&&s.labels.reason==='a"b\\c\nd')?.value).toBe(1);
    const bucket=(le:string)=>parsed.samples.find(s=>s.name==='ptr_z_seconds_bucket'&&s.labels.le===le)?.value;
    expect([bucket('0.5'),bucket('1'),bucket('+Inf')]).toEqual([1,2,3]);
    expect(parsed.samples.find(s=>s.name==='ptr_z_seconds_count')?.value).toBe(3);
    expect(parsed.samples.find(s=>s.name==='ptr_z_seconds_sum')?.value).toBeCloseTo(3.9);
    expect(parsed.samples.find(s=>s.name==='ptr_y')?.value).toBe(1.5);
    expect(text.match(/# TYPE ptr_x_total counter/g)).toHaveLength(1);
  });
  test('the parser rejects malformed lines, unknown types and samples outside their family',()=>{
    expect(()=>parseExposition('# TYPE a counter\na{x="1" 2\n')).toThrow();
    expect(()=>parseExposition('# TYPE a widget\n')).toThrow();
    expect(()=>parseExposition('# TYPE a counter\nb 1\n')).toThrow();
    expect(()=>parseExposition('# TYPE a counter\na one\n')).toThrow();
  });
  test('SDK rejects invalid metric or label names and negative counter increments',()=>{
    expect(()=>new Gauge({name:'bad-name',help:'Bad.',registers:[]})).toThrow();
    expect(()=>new Gauge({name:'ok',help:'Ok.',labelNames:['bad-label'],registers:[]})).toThrow();
    const counter=new Counter({name:'ptr_check_total',help:'Check.',registers:[]});
    expect(()=>counter.inc(-1)).toThrow();
  });
  test('common gauges retain role/version/start values and isolated registries',async()=>{
    const registry=createMetricsRegistry('worker'), second=createMetricsRegistry('api');
    const parsed=parseExposition(await registry.metrics());
    const info=parsed.samples.find(s=>s.name==='ptr_build_info');
    expect(info?.labels.role).toBe('worker');expect(info?.labels.version).toMatch(/^\d+\.\d+\.\d+/);expect(info?.value).toBe(1);
    const started=parsed.samples.find(s=>s.name==='process_start_time_seconds')!.value;
    expect(Math.abs(started-(Date.now()/1000-process.uptime()))).toBeLessThan(5);
    expect(await second.metrics()).not.toContain('role="worker"');
    expect(registry.getSingleMetric('ptr_build_info')).toBeInstanceOf(Gauge);
  });
});

describe('JSON line log',()=>{
  test('one JSON object per line with ts, role, event and constant-like fields only',()=>{
    const lines:string[]=[];const log=createLog('worker',line=>lines.push(line));
    log('turn_finished',{turnId:'3f1c2a9e-0000-4000-8000-000000000001',outcome:'failed',code:'TURN_TIMEOUT',durationMs:31000.4,ok:false,none:null});
    expect(lines).toHaveLength(1);expect(lines[0]!.endsWith('\n')).toBe(true);expect(lines[0]!.trim().split('\n')).toHaveLength(1);
    const entry=JSON.parse(lines[0]!);
    expect(entry).toMatchObject({role:'worker',event:'turn_finished',turnId:'3f1c2a9e-0000-4000-8000-000000000001',outcome:'failed',code:'TURN_TIMEOUT',durationMs:31000,ok:false,none:null});
    expect(Date.parse(entry.ts)).not.toBeNaN();
  });
  test('free text never reaches the log: values that do not look like ids or codes are replaced',()=>{
    const SENTINEL='사용자 문장 SENTINEL-user-text 모델 답변';
    const lines:string[]=[];const log=createLog('api',line=>lines.push(line));
    log('turn_created',{turnId:SENTINEL,note:`x\n${SENTINEL}`,[`bad key ${SENTINEL}`]:'1',count:Number.NaN});
    log(`bad event ${SENTINEL}`,{});
    const text=lines.join('');
    expect(text).not.toContain('SENTINEL');expect(text).not.toContain('사용자');
    const first=JSON.parse(lines[0]!);
    expect(first.turnId).toBe('INVALID');expect(first.note).toBe('INVALID');expect(first.count).toBeNull();
    expect(JSON.parse(lines[1]!).event).toBe('invalid_event');
  });
});

/** A port the OS just handed out and released (the listener under test binds it next). */
const freePort=()=>new Promise<number>(resolve=>{const probe=createServer();probe.listen(0,'127.0.0.1',()=>{const {port}=probe.address() as {port:number};probe.close(()=>resolve(port));});});
describe('metrics listener',()=>{
  const events:{event:string;fields:Record<string,unknown>}[]=[];
  const onEvent=(event:string,fields:Record<string,unknown>={})=>{events.push({event,fields});};
  beforeEach(()=>{events.length=0;});
  test('serves /metrics/prom on loopback with the text content type; other paths 404',async()=>{
    const listener=await startMetricsListener({port:await freePort(),render:()=>'# TYPE a gauge\na 1\n',onEvent});
    try {
      const response=await fetch(`http://127.0.0.1:${listener!.port}/metrics/prom`);
      expect(response.status).toBe(200);expect(response.headers.get('content-type')).toBe(PROM_CONTENT_TYPE);
      expect(await response.text()).toBe('# TYPE a gauge\na 1\n');
      expect((await fetch(`http://127.0.0.1:${listener!.port}/other`)).status).toBe(404);
      // A liveness probe for Compose healthchecks (O5): 200 while the process runs.
      expect((await fetch(`http://127.0.0.1:${listener!.port}/healthz`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${listener!.port}/metrics/prom`,{method:'POST'})).status).toBe(404);
    } finally {await listener?.close();}
  });
  test('a render failure is a 500 with no detail',async()=>{
    const listener=await startMetricsListener({port:await freePort(),render:async()=>{throw new Error('secret detail');},onEvent});
    try {
      const response=await fetch(`http://127.0.0.1:${listener!.port}/metrics/prom`);
      expect(response.status).toBe(500);expect(await response.text()).not.toContain('secret');
    } finally {await listener?.close();}
  });
  test('a port already in use is logged and the process continues without a listener',async()=>{
    const blocker=createServer();await new Promise<void>(resolve=>blocker.listen(0,'127.0.0.1',resolve));
    const port=(blocker.address() as {port:number}).port;
    try {
      await expect(startMetricsListener({port,render:()=>'',onEvent})).resolves.toBeUndefined();
      expect(events).toEqual([{event:'metrics_listener_failed',fields:{port,code:'EADDRINUSE'}}]);
    } finally {await new Promise(resolve=>blocker.close(resolve));}
  });
  test('port 0 disables the listener (nothing is bound, one log line)',async()=>{
    await expect(startMetricsListener({port:0,render:()=>'',onEvent})).resolves.toBeUndefined();
    expect(events).toEqual([{event:'metrics_listener_disabled',fields:{}}]);
  });
  test('PTR_METRICS_PORT: role default, 0 = off, otherwise 1024–65535',()=>{
    expect(metricsPort({},56442)).toBe(56442);
    expect(metricsPort({PTR_METRICS_PORT:'0'},56442)).toBe(0);
    expect(metricsPort({PTR_METRICS_PORT:'56520'},56442)).toBe(56520);
    for(const bad of ['','80','70000','1.5','x']) expect(()=>metricsPort({PTR_METRICS_PORT:bad},56442)).toThrow('INVALID_PTR_METRICS_PORT');
  });
});
