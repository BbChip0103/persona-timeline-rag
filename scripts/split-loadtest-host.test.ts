import {HOST_VMSTAT_KEYS,hostSnapshot,pressureCounters,processCounters,selectedCounters} from './split-loadtest-host';
it('allowlists numeric memory/vmstat/status fields and excludes unexpected process data',()=>{
  expect(selectedCounters('MemAvailable: 100 kB\nSwapFree: 25 kB\nSecret: 123\nMemTotal: invalid\npgfault 123\npgmajfault 5\npswpin 0\npswpout 2',HOST_VMSTAT_KEYS)).toEqual({pgfault:123,pgmajfault:5,pswpin:0,pswpout:2});
  expect(selectedCounters('VmRSS: 12 kB\nName: private\nvoluntary_ctxt_switches: 24\nVmSwap: -1 kB',['VmRSS','VmSwap','voluntary_ctxt_switches'])).toEqual({VmRSS:12,voluntary_ctxt_switches:24});
});
it('records PSI numeric counters only and does not echo malformed lines',()=>{
  expect(pressureCounters('some avg10=1.25 avg60=2.00 avg300=3.12 total=1234 secret=99\nfull avg10=0.00 avg60=0.01 avg300=0.00 total=8\nprivate arbitrary')).toEqual({some:{avg10:1.25,avg60:2,avg300:3.12,total:1234},full:{avg10:0,avg60:.01,avg300:0,total:8}});
});
it('parses process stat after the final comm parenthesis, exposing only owned numeric counters',()=>{
  const fields=['S',...Array.from({length:21},(_,i)=>String(i+1))];
  const result=processCounters(`123 (private ) name) ${fields.join(' ')}`);
  expect(result).toEqual({parentPid:1,userTicks:11,systemTicks:12,threads:17,startTicks:19,virtualBytes:20,residentPages:21});expect(processCounters('invalid')).toEqual({});
});
it('reports missing process metadata explicitly without argv/env reads or fabricated zeroes',async()=>{
  const snapshot=await hostSnapshot([2147483647,-1,NaN,process.pid]);
  expect(snapshot.processes.map(p=>p.pid)).toEqual([process.pid,2147483647]);expect(snapshot.processes[1]).toMatchObject({available:false,counters:null,memoryKbAndSwitches:null});expect(snapshot.available).toBe(false);
  expect(snapshot.probeElapsedMs).toBeGreaterThanOrEqual(0);expect(snapshot.cpuCount).toBeGreaterThan(0);
  expect(Object.keys(snapshot)).not.toEqual(expect.arrayContaining(['env','argv','payload']));
});
