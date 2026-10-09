import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadConfig } from '@ptr/ops';
import { productionEnvironment, upstreamFromEnvironment } from '../src/main';
import { UpstreamPool } from '../src/pool';

// : without PTR_DEMO_SCALING the gateway serves the upstreams file's only pool, named after it.
let dir:string;
beforeAll(()=>{dir=mkdtempSync(join(tmpdir(),'ptr-gw-profile-'));});
afterAll(()=>rmSync(dir,{recursive:true,force:true}));
const file=(pools:Record<string,unknown>)=>{const path=join(dir,`${Object.keys(pools).join('-')}.json`);writeFileSync(path,JSON.stringify({pools}));return path;};
const TOKEN='synthetic_gateway_token_abcdefghij';

test('one pool: its name is derived and the pool is built from the file',async()=>{
  const env={PTR_GATEWAY_TOKEN:TOKEN,PTR_GATEWAY_UPSTREAMS_FILE:file({'synthetic-model':{upstreams:[{id:'a',baseUrl:'http://127.0.0.1:18000/v1'}]}})};
  const config=loadConfig('gateway',env,()=>undefined);
  expect(config.pool).toBe('synthetic-model');
  const {upstream,close}=upstreamFromEnvironment(productionEnvironment(env,config.pool!));
  expect(upstream).toBeInstanceOf(UpstreamPool);
  await upstream.ready?.(AbortSignal.timeout(1000));
  expect((upstream as UpstreamPool).poolMetrics()).toMatchObject({pool:'synthetic-model',registry:{discovery:'file'}});
  await close?.();
});
test('two pools: startup fails with upstreams_pool_count',()=>{
  const lines:string[]=[];
  const env={PTR_GATEWAY_TOKEN:TOKEN,PTR_GATEWAY_UPSTREAMS_FILE:file({a:{upstreams:[]},b:{upstreams:[]}})};
  expect(()=>loadConfig('gateway',env,line=>lines.push(line))).toThrow(ConfigError);
  expect(JSON.parse(lines[0]!)).toEqual({event:'config_invalid',role:'gateway',problems:[{key:'PTR_GATEWAY_UPSTREAMS_FILE',rule:'upstreams_pool_count'}]});
});
