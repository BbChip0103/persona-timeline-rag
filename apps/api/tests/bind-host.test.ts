import {apiBindHost} from '../src/bind-host';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

test.each([
  [undefined,'127.0.0.1'],
  ['127.0.0.1','127.0.0.1'],
  ['0.0.0.0','0.0.0.0'],
])('api bind host %s resolves to %s', (configured,expected)=>{
  expect(apiBindHost(configured)).toBe(expected);
});

test.each(['','localhost','192.0.2.1','::','example.com'])('api rejects unexpected bind host %s',configured=>{
  expect(()=>apiBindHost(configured)).toThrow();
});

test('web Compose bind retains its loopback default and accepts an override',()=>{
  const compose=readFileSync(join(__dirname,'../../../infra/compose.app.yml'),'utf8');
  expect(compose).toContain('--hostname, "${PTR_WEB_HOST:-127.0.0.1}"');
});
