import { acceptance, findKnee, meanInterval, medianKnee, mergePoints, plan, pointStats, type Sample } from '../routing-compare';

describe('routing comparison methodology',()=>{
  test('arrivals are fully seeded: the same seed gives byte-identical plans (token lengths, flows, W3 turns); another seed differs',()=>{
    for(const workload of ['W1','W2','W3','W4']) {
      const a=plan(workload,6,10000,7,'open'), b=plan(workload,6,10000,7,'open');
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      expect(JSON.stringify(plan(workload,6,10000,8,'open'))).not.toBe(JSON.stringify(a));
    }
  });
  test('open-loop W3: every turn of every session is scheduled up front at fixed times, with its history already built',()=>{
    const arrivals=plan('W3',6,20000,3,'open');
    expect(arrivals.length).toBeGreaterThan(20);
    expect(arrivals.every(a=>a.messages.length>0&&!a.session)).toBe(true);
    const bySession=new Map<string,typeof arrivals>();
    for(const a of arrivals) bySession.set(a.flow,[...(bySession.get(a.flow)??[]),a]);
    for(const turns of bySession.values()) {
      for(let i=1;i<turns.length;i++) {
        expect(turns[i]!.at-turns[i-1]!.at).toBeCloseTo(2500,6);
        expect(turns[i]!.messages.length).toBe(turns[i-1]!.messages.length+2); // the previous user turn + its answer
      }
    }
    expect([...arrivals].sort((x,y)=>x.at-y.at).map(a=>a.at)).toEqual(arrivals.map(a=>a.at));
    const closed=plan('W3',6,20000,3,'closed');
    expect(closed.every(a=>a.session&&a.messages.length===0)).toBe(true);
  });
  test('point statistics count every request started in the window: rejected, failed and unfinished ones make TTFT p95 infinite past 5%',()=>{
    const ok=(ttft:number):Sample=>({start:4000,ttft,e2e:ttft+500,status:200,flow:'a'});
    const samples:Sample[]=[...Array.from({length:19},(_,i)=>ok(100+i)),{start:4000,ttft:null,e2e:null,status:429,flow:'b'},
      {start:1000,ttft:50,e2e:60,status:200,flow:'a'}]; // the last one started in the warm-up: ignored
    const stats=pointStats(samples,{windowStart:3000,windowEnd:23000,unfinished:0});
    expect(stats).toMatchObject({requests:20,completed:19,rejected:{queue_full:1},failed:1,ttftP95Completed:118,ttftP95All:118,throughput:0.95});
    const worse=pointStats([...samples,{start:5000,ttft:null,e2e:null,status:599,flow:'c'}],{windowStart:3000,windowEnd:23000,unfinished:1});
    expect(worse).toMatchObject({requests:22,failed:3,unfinished:1,ttftP95All:null}); // 3/22 > 5%: p95 is a failure (∞)
  });
  test('the knee is the highest rate of the monotone prefix that keeps TTFT p95 (failures = ∞) at or under 2 s',()=>{
    expect(findKnee([{rate:4,ttftP95All:300},{rate:6,ttftP95All:900},{rate:8,ttftP95All:1900},{rate:10,ttftP95All:2600},{rate:12,ttftP95All:1500}])).toBe(8);
    expect(findKnee([{rate:4,ttftP95All:null}])).toBe(4); // nothing qualifies: the lowest rate
  });
  test('mean with a 95% t interval over seeds',()=>{
    expect(meanInterval([10,12,14])).toEqual({mean:12,low:7.031,high:16.969,n:3});
    expect(meanInterval([5])).toEqual({mean:5,low:null,high:null,n:1});
    expect(meanInterval([])).toBeNull();
  });
  test('acceptance keeps the pre-registered thresholds: one metric ≥ 10% better with the other ≤ 5% worse (heterogeneous W2/W3), both ≤ 5% worse (homogeneous W1)',()=>{
    const per=(thr:number[],ttft:(number|null)[])=>({maxThroughputUnderSlo:thr,ttftP95AtKnee:ttft});
    const result=acceptance({
      heterogeneousW2:{scored:per([11,11.2,10.8],[900,950,1000]),least_inflight:per([10,10,10],[1000,1000,1000])},
      heterogeneousW3:{scored:per([10,10,10],[1200,1300,1250]),least_inflight:per([10,10,10],[1000,1000,1000])},
      homogeneousW1:{scored:per([9.6,9.6,9.6],[1000,1000,1000]),least_inflight:per([10,10,10],[1000,1000,1000])},
    });
    expect(result.verdict).toEqual({heterogeneousW2:true,heterogeneousW3:false,homogeneousW1:true,scoredBecomesDefault:false});
    expect(result.comparisons.heterogeneousW2).toMatchObject({throughputGain:0.1,ttftP95Gain:0.05});
    expect(result.comparisons.heterogeneousW3.ttftP95Gain).toBe(-0.25);
    expect(result.comparisons.heterogeneousW2.paired.throughputGain).toMatchObject({mean:0.1,n:3});
  });
  test('an infinite TTFT p95 (a seed with > 5% failures) is a loss, not neutral: only scored ∞ → −∞, only least_inflight ∞ → +∞, both → null',()=>{
    const per=(thr:number[],ttft:(number|null)[])=>({maxThroughputUnderSlo:thr,ttftP95AtKnee:ttft});
    const finite=per([10],[1000]);
    // scored ∞ with +20% throughput: the TTFT half is −∞, so neither "better" nor "not worse".
    const lose=acceptance({heterogeneousW2:{scored:per([12,12,12],[null,900,900]),least_inflight:per([10,10,10],[1000,1000,1000])},
      heterogeneousW3:{scored:finite,least_inflight:finite},homogeneousW1:{scored:per([12,12,12],[null,900,900]),least_inflight:per([10,10,10],[1000,1000,1000])}});
    expect(lose.comparisons.heterogeneousW2.ttftP95Gain).toBe(-Infinity);
    expect(lose.verdict).toMatchObject({heterogeneousW2:false,homogeneousW1:false});
    const win=acceptance({heterogeneousW2:{scored:per([10],[900]),least_inflight:per([10],[null])},heterogeneousW3:{scored:per([10],[null]),least_inflight:per([10],[null])},
      homogeneousW1:{scored:finite,least_inflight:finite}});
    expect(win.comparisons.heterogeneousW2.ttftP95Gain).toBe(Infinity);expect(win.verdict.heterogeneousW2).toBe(true);
    expect(win.comparisons.heterogeneousW3.ttftP95Gain).toBeNull();expect(win.verdict.heterogeneousW3).toBe(false);
  });
  test('--merge refuses the same point twice; the knee for the grid is the median of the per-seed knees',()=>{
    const point=(seed:number)=>({config:'heterogeneous',workload:'W2',policy:'scored',seed,factor:1});
    expect(mergePoints([[point(1)],[point(2)]])).toHaveLength(2);
    expect(()=>mergePoints([[point(1)],[point(1)]])).toThrow('MERGE_DUPLICATE_POINT');
    expect(medianKnee([6,7.5,9])).toBe(7.5);expect(medianKnee([6,9])).toBe(7.5);expect(medianKnee([4])).toBe(4);
  });
});
