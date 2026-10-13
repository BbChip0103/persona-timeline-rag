import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import IORedis from '../../../packages/messaging/node_modules/ioredis';
import {RateLimiterMemory} from 'rate-limiter-flexible';
import {createDraftLimiter} from '../src/draft-limiter';

const REDIS_PASSWORD='synthetic-draft-limiter-password';
const REDIS_IMAGE='redis:7.4.5-alpine@sha256:bb186d083732f669da90be8b0f975a37812b15e913465bb14d845db72a4e3e08';
const containerName=`ptr-draft-limiter-${process.pid}-${randomUUID().slice(0,8)}`;
let redisUrl='';
let containerStarted=false;

function docker(args:string[]):void {
  const result=spawnSync('docker',args,{encoding:'utf8',timeout:15000});
  if(result.status!==0) throw new Error(`docker ${args[0]} failed`);
}

async function freeLoopbackPort():Promise<number> {
  return new Promise((resolve,reject)=>{
    const server=createServer();
    server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>{
      const address=server.address();
      server.close(()=>typeof address==='object'&&address?resolve(address.port):reject(new Error('no loopback port')));
    });
  });
}

async function waitForRedis():Promise<void> {
  const redis=new IORedis(redisUrl,{maxRetriesPerRequest:1,commandTimeout:500});
  try {
    for(let attempt=0;attempt<40;attempt++) {
      try {await redis.ping();return;} catch {await new Promise(resolve=>setTimeout(resolve,250));}
    }
    throw new Error('draft limiter Redis did not become ready');
  } finally {redis.disconnect();}
}

describe('native per-owner draft admission',()=>{
  beforeAll(async()=>{
    const port=await freeLoopbackPort();
    redisUrl=`redis://:${REDIS_PASSWORD}@127.0.0.1:${port}/0`;
    docker(['run','--rm','-d','--name',containerName,'--label',`com.docker.compose.project=${containerName}`,'-p',`127.0.0.1:${port}:6379`,REDIS_IMAGE,'redis-server','--requirepass',REDIS_PASSWORD,'--save','']);
    containerStarted=true;
    await waitForRedis();
  });
  afterAll(()=>{if(containerStarted) docker(['rm','-f',containerName]);});
  afterEach(()=>{jest.restoreAllMocks();});

  test('two limiter instances sharing Redis enforce the combined owner quota',async()=>{
    const firstRedis=new IORedis(redisUrl,{maxRetriesPerRequest:1,commandTimeout:3000});
    const secondRedis=new IORedis(redisUrl,{maxRetriesPerRequest:1,commandTimeout:3000});
    try {
      await firstRedis.flushdb();
      const first=createDraftLimiter(1,firstRedis),second=createDraftLimiter(1,secondRedis);
      await first('owner-a');
      await expect(second('owner-a')).rejects.toMatchObject({code:'QUEUE_FULL'});
      await expect(second('owner-b')).resolves.toBeUndefined();
      expect(await firstRedis.ttl('ptr:ratelimit:draft:owner-a')).toBeGreaterThan(0);
    } finally {firstRedis.disconnect();secondRedis.disconnect();}
  });
});

test('synthetic fixture keeps the same owner window and QUEUE_FULL code',async()=>{
  jest.useFakeTimers();jest.setSystemTime(1000);
  const consume=jest.spyOn(RateLimiterMemory.prototype,'consume');
  try {
    const admit=createDraftLimiter(2);
    await admit('owner-a');await admit('owner-a');
    await expect(admit('owner-a')).rejects.toMatchObject({code:'QUEUE_FULL'});
    await admit('owner-b');
    jest.advanceTimersByTime(60000);
    await expect(admit('owner-a')).resolves.toBeUndefined();
    expect(consume).toHaveBeenCalledWith('owner-a',1);
  } finally {consume.mockRestore();jest.useRealTimers();}
});
