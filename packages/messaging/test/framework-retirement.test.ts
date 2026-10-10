import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as connectionBoundary from '../src/registry';

const repository=resolve(__dirname,'../../..');

describe('big-bang framework retirement boundaries',()=>{
  test.each([
    'apps/gateway/package.json',
    'apps/gateway/src/main.ts',
    'apps/api/src/dispatcher.ts',
    'apps/api/src/capacity.ts',
    'packages/messaging/src/upstream-registry.ts',
    'packages/messaging/src/gateway-registry.ts',
    'packages/messaging/src/capacity-controller.ts',
    'scripts/upstream-agent.ts',
  ])('no active superseded implementation at %s',path=>{
    expect(existsSync(resolve(repository,path))).toBe(false);
  });
  test('retained Redis connection subpath exposes no fleet discovery or capacity controller',()=>{
    expect(Object.keys(connectionBoundary).sort()).toEqual(['REDIS_PREFIX','assertLocalRedisUrl','createRedisConnection'].sort());
  });
});
