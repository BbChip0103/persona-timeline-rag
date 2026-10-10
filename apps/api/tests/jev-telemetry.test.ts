import type { FrameworkObservation, FrameworkTelemetry } from '@ptr/ops';
import type { OpenRouterClient } from '@ptr/providers';
import { observeJevDecisions } from '../src/runtime';

const request={model:'typesafe/jev-1.13',state:{text:'PRIVATE_DECISION_TEXT'},questions:{private:'PRIVATE_QUESTION'}};
const options={signal:new AbortController().signal,idempotencyKey:'PRIVATE_TURN_KEY'};
function fixture(result:Record<string,unknown>) {
  const update=jest.fn(),client={decide:jest.fn(async()=>result)},names:string[]=[];
  const telemetry:Pick<FrameworkTelemetry,'generation'>={generation:async<T>(name:string,work:(span:FrameworkObservation)=>Promise<T>)=>{names.push(name);return work({update});}};
  return {client,update,names,observed:observeJevDecisions(client,telemetry)};
}
test('Jev generation observes actual receipt usage/cost without another request or private decision data',async()=>{
  const result={model:'typesafe/jev-1.13-20260901',answers:{private:'PRIVATE_ANSWER'},usage:{input_tokens:476,output_tokens:70,cost:0.000019992}};
  const f=fixture(result);
  await expect(f.observed.decide(request,options)).resolves.toBe(result);
  expect(f.client.decide).toHaveBeenCalledTimes(1);expect(f.client.decide).toHaveBeenCalledWith(request,options);
  expect(f.names).toEqual(['jev']);expect(f.update).toHaveBeenCalledWith({model:'typesafe/jev-1.13',metadata:{kind:'decision',accounting:'reported-receipt'}});
  expect(f.update).toHaveBeenCalledWith({usageDetails:{input:476,output:70},costDetails:{total:0.000019992}});
  expect(JSON.stringify(f.update.mock.calls)).not.toContain('PRIVATE_');
});
test.each([undefined,{}, {input_tokens:-1,output_tokens:1.5,cost:-1}, {input_tokens:NaN,output_tokens:Infinity,cost:Infinity}])('missing/invalid Jev metrics are not manufactured (%j)',async usage=>{
  const f=fixture({usage});await f.observed.decide({...request,model:'PRIVATE_MODEL_PATH'},options);
  const updates=f.update.mock.calls.map(([value])=>value as Parameters<FrameworkObservation['update']>[0]);
  expect(updates.every(value=>!value.costDetails&&!value.usageDetails)).toBe(true);
  expect(updates[0].model).toBe('unknown');expect(JSON.stringify(updates)).not.toContain('PRIVATE_');
});
test('legacy reported token field names and reported zero cost remain accurate',async()=>{
  const f=fixture({usage:{prompt_tokens:0,completion_tokens:12,cost:0}});await f.observed.decide(request,options);
  expect(f.update).toHaveBeenCalledWith({usageDetails:{input:0,output:12},costDetails:{total:0}});
});
test('Jev failure is observed once without retrying, converting, or exporting its private error',async()=>{
  const error=new Error('PRIVATE_FAILURE');const client:Pick<OpenRouterClient,'decide'>={decide:jest.fn(async()=>{throw error;})};
  const update=jest.fn(),names:string[]=[];
  const telemetry:Pick<FrameworkTelemetry,'generation'>={generation:async<T>(name:string,work:(span:FrameworkObservation)=>Promise<T>)=>{names.push(name);return work({update});}};
  await expect(observeJevDecisions(client,telemetry).decide(request,options)).rejects.toBe(error);
  expect(client.decide).toHaveBeenCalledTimes(1);expect(names).toEqual(['jev']);expect(JSON.stringify(update.mock.calls)).not.toContain('PRIVATE_');
});
