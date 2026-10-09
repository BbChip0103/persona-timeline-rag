import { register } from '../../../apps/web/instrumentation';
import { apiUrl, checkWebConfig, registerWebConfig } from '../../../apps/web/lib/config';

// : the web validates its keys in instrumentation.ts register(), except during `next build`.
const valid={PTR_API_TOKEN:'synthetic-api-token-at-least-24-characters',PTR_SESSION_SECRET:'synthetic-session-secret-at-least-32-characters',PTR_UI_PASSWORD:'synthetic'};
const SENTINEL='SENTINEL-web-value-0123456789';

describe('web register()',()=>{
  const saved={...process.env};
  afterEach(()=>{process.env={...saved};});
  test('is skipped in the production build phase (no secrets there)',async()=>{
    process.env={NEXT_PHASE:'phase-production-build'};
    const spy=jest.spyOn(console,'error').mockImplementation(()=>undefined);
    const exit=jest.fn();
    try {await register(exit);expect(spy).not.toHaveBeenCalled();expect(exit).not.toHaveBeenCalled();} finally {spy.mockRestore();}
  });
  test('refuses to start with an invalid configuration and prints keys and rule ids only',async()=>{
    process.env={PTR_API_TOKEN:SENTINEL.slice(0,8),PTR_UI_PASSWORD:SENTINEL,PTR_API_URL:`http://${SENTINEL}`};
    const lines:string[]=[];const spy=jest.spyOn(console,'error').mockImplementation(line=>{lines.push(String(line));});
    const exit=jest.fn();
    try {await register(exit);} finally {spy.mockRestore();}
    expect(exit).toHaveBeenCalledWith(1);
    expect(lines.join('\n')).not.toContain(SENTINEL);
    expect(JSON.parse(lines[0]!)).toEqual({event:'config_invalid',role:'web',problems:[{key:'PTR_API_URL',rule:'api_url_constant'},
      {key:'PTR_API_TOKEN',rule:'token_length'},{key:'PTR_SESSION_SECRET',rule:'missing'}]});
  });
  test('starts with a valid configuration',async()=>{
    process.env={...valid};
    const exit=jest.fn();await register(exit);expect(exit).not.toHaveBeenCalled();
  });
});
test('PTR_API_URL: the constant warns, anything else fails; the synthetic UI keeps its own port',()=>{
  const lines:string[]=[];
  registerWebConfig({...valid,PTR_API_URL:'http://127.0.0.1:56441'},line=>lines.push(line));
  expect(lines.map(line=>JSON.parse(line))).toEqual([{event:'config_warning',role:'web',problems:[{key:'PTR_API_URL',rule:'constant_ignored'}]}]);
  expect(checkWebConfig({...valid}).errors).toEqual([]);
  expect(checkWebConfig({...valid,PTR_API_URL:'http://127.0.0.1:56449'}).errors).toEqual([{key:'PTR_API_URL',rule:'api_url_constant'}]);
  expect(apiUrl({})).toBe('http://127.0.0.1:56441');
  // e2e (PTR_SYNTHETIC_UI=1) never reaches the research API: its target is the synthetic port.
  expect(apiUrl({PTR_SYNTHETIC_UI:'1'})).toBe('http://127.0.0.1:56449');
  expect(checkWebConfig({...valid,PTR_SYNTHETIC_UI:'1',PTR_API_URL:'http://127.0.0.1:56449'})).toEqual({errors:[],warnings:[{key:'PTR_API_URL',rule:'constant_ignored'}]});
});
