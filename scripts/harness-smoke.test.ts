import { runSmoke } from './harness-smoke';
const integration=process.env.RUN_STORAGE_DB_TESTS==='1'&&!!process.env.DATABASE_URL?describe:describe.skip;
integration('synthetic SQL smoke using shared ChatService',()=>{
  it('checks all modes, owner isolation, idempotency, history and retrieval-off zero calls',async()=>{
    const report=await runSmoke(process.env);expect(report.executionMode).toBe('fake');expect(report.checks).toBeGreaterThan(20);
    expect(report.offCalls).toEqual({retrieval:0,embedding:0});expect(report.textCalls).toBeGreaterThan(0);
  });
});
