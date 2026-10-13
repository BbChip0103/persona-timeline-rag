import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import IORedis from '../../web/node_modules/ioredis';

const REDIS_PASSWORD='synthetic-login-limiter-password';
const REDIS_IMAGE='redis:7.4.5-alpine@sha256:bb186d083732f669da90be8b0f975a37812b15e913465bb14d845db72a4e3e08';
const containerName=`ptr-login-limiter-${process.pid}-${randomUUID().slice(0,8)}`;
let redisUrl='';
let containerStarted=false;

async function loadLoginLimiter():Promise<typeof import('../../web/lib/login-limiter')> {
  return import('../../web/lib/login-limiter');
}

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
    throw new Error('login limiter Redis did not become ready');
  } finally {redis.disconnect();}
}

describe('web login limiter Redis storage',()=>{
  beforeAll(async()=>{
    const port=await freeLoopbackPort();
    redisUrl=`redis://:${REDIS_PASSWORD}@127.0.0.1:${port}/0`;
    docker(['run','--rm','-d','--name',containerName,'--label',`com.docker.compose.project=${containerName}`,'-p',`127.0.0.1:${port}:6379`,REDIS_IMAGE,'redis-server','--requirepass',REDIS_PASSWORD,'--save','']);
    containerStarted=true;
    await waitForRedis();
  });
  afterAll(()=>{if(containerStarted) docker(['rm','-f',containerName]);});

  test('cluster mode refuses startup without PTR_WEB_REDIS_URL',async()=>{
    const originalNetworkMode=process.env.PTR_NETWORK_MODE;
    const originalWebRedisUrl=process.env.PTR_WEB_REDIS_URL;
    try {
      jest.resetModules();
      process.env.PTR_NETWORK_MODE='cluster';
      delete process.env.PTR_WEB_REDIS_URL;
      await expect(loadLoginLimiter()).rejects.toThrow('PTR_WEB_REDIS_URL is required in cluster mode');
    } finally {
      if(originalNetworkMode===undefined) delete process.env.PTR_NETWORK_MODE; else process.env.PTR_NETWORK_MODE=originalNetworkMode;
      if(originalWebRedisUrl===undefined) delete process.env.PTR_WEB_REDIS_URL; else process.env.PTR_WEB_REDIS_URL=originalWebRedisUrl;
      jest.resetModules();
    }
  });

  test('two limiter instances sharing Redis enforce the combined login quota',async()=>{
    const firstRedis=new IORedis(redisUrl,{maxRetriesPerRequest:1,commandTimeout:3000});
    const secondRedis=new IORedis(redisUrl,{maxRetriesPerRequest:1,commandTimeout:3000});
    try {
      await firstRedis.flushdb();
      const {createLoginLimiter}=await loadLoginLimiter();
      const env={
        PTR_NETWORK_MODE:'cluster',
        KUBERNETES_SERVICE_HOST:'10.0.0.1',
        PTR_WEB_REDIS_URL:'rediss://ptr:synthetic-password@redis.example.internal:6380/0',
        PTR_CLUSTER_REDIS_URL_ALLOWLIST:'rediss://ptr@redis.example.internal:6380',
      } as NodeJS.ProcessEnv;
      const first=createLoginLimiter(env,firstRedis),second=createLoginLimiter(env,secondRedis);
      for(let i=0;i<10;i++) await first.penalty('local-owner',1);
      await expect(second.consume('local-owner',0)).resolves.toMatchObject({consumedPoints:10,remainingPoints:0});
      await expect(second.penalty('local-owner',1)).resolves.toMatchObject({consumedPoints:11,remainingPoints:0});
      await expect(second.consume('other-owner',0)).resolves.toMatchObject({consumedPoints:0});
    } finally {firstRedis.disconnect();secondRedis.disconnect();}
  });
});
