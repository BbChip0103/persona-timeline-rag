import {createLog,type LogFields} from '../src/log';
import pino from 'pino';
jest.mock('pino',()=>{
  const native=jest.requireActual('pino');
  return Object.assign(jest.fn((...args:unknown[])=>native(...args)),native);
});

test('genuine Pino factory owns serialization and configured redaction',()=>{
  createLog('api',()=>undefined)('turn_created',{turnId:'synthetic-turn'});
  expect(pino).toHaveBeenCalled();
  const options=(pino as unknown as jest.Mock).mock.calls.at(-1)![0];
  const lines:string[]=[];
  const native=jest.requireActual('pino');
  native(options,{write:(line:string)=>lines.push(line)}).info({turnId:'synthetic-turn',token:'ASCII_SECRET',password:'ASCII_SECRET'});
  expect(JSON.parse(lines[0]!)).toEqual({role:'api',turnId:'synthetic-turn'});
});

test('logging has no automatic bindings/levels and preserves approved ID correlation',()=>{
  const lines:string[]=[];const log=createLog('api',line=>lines.push(line));
  log('turn_created',{turnId:'synthetic-turn',count:1.7,nan:NaN,missing:undefined});
  const value=JSON.parse(lines[0]!);
  expect(Object.keys(value)).toEqual(['role','ts','event','turnId','count','nan']);
  expect(value).toMatchObject({role:'api',event:'turn_created',turnId:'synthetic-turn',count:2,nan:null});
  expect(lines[0]!.split('\n')).toHaveLength(2);
});
test('sensitive names, nested values and getters are never forwarded into log serialization',()=>{
  const lines:string[]=[];const log=createLog('api',line=>lines.push(line));
  const getter=jest.fn(()=>({private:'SENTINEL'}));
  const circular:Record<string,unknown>={};circular.self=circular;
  const fields={turnId:'synthetic-turn',token:'sk-synthetic-secret',apiKey:'ASCII_SECRET',password:'ASCII_SECRET',body:'ASCII_BODY',caption:'ASCII_CAPTION',authorization:'ASCII_SECRET',error:'ASCII_ERROR',stack:'ASCII_STACK',object:{private:'SENTINEL'},array:['SENTINEL'],buffer:Buffer.from('SENTINEL'),err:new Error('SENTINEL'),circular,big:1n,fn:()=>undefined};
  Object.defineProperty(fields,'getter',{enumerable:true,get:getter});
  Object.defineProperty(fields,'privateCode',{enumerable:false,value:'ASCII_HIDDEN'});
  expect(()=>log('turn_created',fields as unknown as LogFields)).not.toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(lines.join('')).not.toMatch(/SENTINEL|ASCII_|sk-synthetic/);
  expect(JSON.parse(lines[0]!)).toEqual({ts:expect.any(String),role:'api',event:'turn_created',turnId:'synthetic-turn'});
});
