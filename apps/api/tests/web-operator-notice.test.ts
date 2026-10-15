import { GET } from '../../web/app/api/proxy/[...path]/route';
jest.mock('../../web/lib/auth',()=>({localHost:()=>true,sameOrigin:()=>true,signedOwner:async()=> 'synthetic-owner'}));
jest.mock('../../web/lib/config',()=>({apiUrl:()=> 'http://127.0.0.1:56449'}));
const originalFetch=global.fetch;
afterEach(()=>{global.fetch=originalFetch;jest.restoreAllMocks();delete process.env.PTR_API_TOKEN;});
test.each([[true,false,1],[true,true,0],[false,false,0]] as const)('BFF mismatch diagnostic operator=%s API=%s',async(operatorMode,apiOptions,warnings)=>{
 process.env.PTR_API_TOKEN='synthetic-token-at-least-24-characters';
 global.fetch=jest.fn(async()=>Response.json({operatorMode,operatorOptionsAvailable:apiOptions,personas:[]}));const warn=jest.spyOn(console,'warn').mockImplementation(()=>{});
 const response=await GET(new Request('http://127.0.0.1:56440/api/proxy/personas'),{params:Promise.resolve({path:['personas']})});
 expect(response.status).toBe(200);const body=await response.json();
 expect(Boolean(body.operatorNotice)).toBe(operatorMode&&!apiOptions);expect(warn).toHaveBeenCalledTimes(warnings);
 if(warnings)expect(warn).toHaveBeenCalledWith('PTR_OPERATOR_OPTIONS_DISABLED');
});
