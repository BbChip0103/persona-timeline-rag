// The load test wipes its queue with a fresh BullMqTurnDelivery that never published anything: `close(true)` must
// still obliterate (it used to return early on an unopened queue, leaving ptr:loadtest-turns:* behind).
const queues: { name: string; obliterated: boolean; closed: boolean }[] = [];
let failObliterate = false;
jest.mock('bullmq', () => ({
  Queue: class {
    readonly state: { name: string; obliterated: boolean; closed: boolean };
    constructor(name: string) { this.state = { name, obliterated: false, closed: false }; queues.push(this.state); }
    async obliterate() { if (failObliterate) throw new Error('redis down'); this.state.obliterated = true; }
    async close() { this.state.closed = true; }
  },
  Worker: class {},
}));
const quits: number[] = [];
jest.mock('../src/redis', () => ({ ...jest.requireActual('../src/redis'), createRedisConnection: () => ({ quit: async () => { quits.push(1); } }) }));
import { BullMqTurnDelivery } from '../src/bullmq-delivery';

const url = 'redis://ptr:synthetic@127.0.0.1:56479/0';
beforeEach(() => { queues.length = 0; quits.length = 0; failObliterate = false; });
test('a failed obliterate still closes the queue and its connection (a run never hangs on cleanup)', async () => {
  failObliterate = true;
  await expect(new BullMqTurnDelivery(url, { queueName: 'loadtest-turns' }).close(true)).rejects.toThrow('redis down');
  expect(queues).toEqual([{ name: 'loadtest-turns', obliterated: false, closed: true }]);expect(quits).toHaveLength(1);
});
test('close(true) on a delivery that never opened its queue opens it, obliterates it and releases the connection', async () => {
  await new BullMqTurnDelivery(url, { queueName: 'loadtest-turns' }).close(true);
  expect(queues).toEqual([{ name: 'loadtest-turns', obliterated: true, closed: true }]);
  expect(quits).toHaveLength(1);
});
test('close() without obliterate on an unopened queue still opens no connection', async () => {
  await new BullMqTurnDelivery(url, { queueName: 'loadtest-turns' }).close();
  expect(queues).toEqual([]);expect(quits).toHaveLength(0);
});
