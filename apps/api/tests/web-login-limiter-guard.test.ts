import IORedis from '../../web/node_modules/ioredis';
import {createLoginLimiter} from '../../web/lib/login-limiter';

test('Kubernetes pod requires Redis even when network mode is unset',()=>{
  expect(()=>createLoginLimiter({KUBERNETES_SERVICE_HOST:'10.0.0.1'} as NodeJS.ProcessEnv))
    .toThrow('PTR_WEB_REDIS_URL is required in cluster mode');
});

test('web Redis limiter handles errors without logging their details',()=>{
  const redis=new IORedis('redis://:synthetic-password@127.0.0.1:58479/0',{lazyConnect:true});
  const log=jest.spyOn(console,'error').mockImplementation(()=>undefined);
  try {
    createLoginLimiter({PTR_WEB_REDIS_URL:'redis://:synthetic-password@127.0.0.1:58479/0'} as NodeJS.ProcessEnv,redis);
    expect(redis.listenerCount('error')).toBeGreaterThan(0);
    redis.emit('error',new Error('synthetic-secret-error-detail'));
    expect(log).not.toHaveBeenCalled();
  } finally {
    redis.disconnect();
    log.mockRestore();
  }
});
