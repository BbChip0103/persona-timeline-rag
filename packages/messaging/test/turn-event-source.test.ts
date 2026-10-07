import { EventEmitter } from 'node:events';

// A stand-in ioredis subscriber: the first SUBSCRIBE fails (e.g. Redis briefly unreachable), later ones succeed.
const fake = Object.assign(new EventEmitter(), {
  subscribeCalls: 0,
  subscribe: jest.fn(async () => { fake.subscribeCalls++; if (fake.subscribeCalls === 1) throw new Error('connection lost'); return 1; }),
  unsubscribe: jest.fn(async () => 1),
  quit: jest.fn(async () => 'OK'),
});
jest.mock('../src/redis', () => ({ REDIS_PREFIX: 'ptr', createRedisConnection: () => fake }));
import { RedisTurnEventSource } from '../src/turn-events';

test('a failed SUBSCRIBE does not poison later subscriptions to the same turn', async () => {
  const source = new RedisTurnEventSource('redis://:pw@127.0.0.1:56479/0', { namespace: 'unit' });
  await expect(source.subscribe('turn-1', () => undefined)).rejects.toThrow('connection lost');
  const seen: string[] = [];
  const off = await source.subscribe('turn-1', event => seen.push(event.state));
  expect(fake.subscribe).toHaveBeenCalledTimes(2);
  fake.emit('message', 'ptr:unit:turn:turn-1', JSON.stringify({ turnId: 'turn-1', state: 'completed' }));
  expect(seen).toEqual(['completed']);
  off();
  expect(fake.unsubscribe).toHaveBeenCalledWith('ptr:unit:turn:turn-1');
});
