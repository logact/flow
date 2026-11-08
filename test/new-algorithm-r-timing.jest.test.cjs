const fs=require('node:fs');
const {RReadingClock,rTimingProtocol}=require('../lib/new-algorithm-r-timing.ts');
describe('R fluency timing',()=>{
 test('accumulates initial reading and reread but excludes answer time',()=>{let now=0;const c=new RReadingClock(()=>now);c.startRead();now=20000;c.endRead();c.beginAnswer();now=60000;c.review();c.startRead();now=70000;c.endRead();c.beginAnswer();now=110000;const r=c.submit(100);expect(r).toMatchObject({valid:true,readingSeconds:30,wpm:200});});
 test('interruption invalidates and reset cannot reuse prior elapsed time',()=>{let now=0;const c=new RReadingClock(()=>now);c.startRead();now=10000;c.interrupt();c.reset();c.startRead();now=30000;c.endRead();c.beginAnswer();expect(c.submit(100)).toMatchObject({valid:true,readingSeconds:20,wpm:300});});
 test('rejects duplicate/unbalanced events and exposes replay boundary',()=>{expect(rTimingProtocol([{type:'read_end',at:10},{type:'answer_submit',at:20}],100).valid).toBe(false);});
 test('replays review transition and accumulates both visible reading segments',()=>{const r=rTimingProtocol([{type:'read_start',at:0},{type:'read_end',at:20000},{type:'answer_start',at:20000},{type:'review_start',at:60000},{type:'review_end',at:70000},{type:'answer_start',at:70000},{type:'answer_submit',at:110000}],100);expect(r).toMatchObject({valid:true,readingSeconds:30,wpm:200});});
 test('rejects a zero-second read',()=>{const c=new RReadingClock(()=>100);c.startRead();c.endRead();c.beginAnswer();expect(c.submit(100)).toMatchObject({valid:false,reason:'zero_read_time',wpm:null});});
 test('renderer does not expose the passage until the timed read starts',()=>{const s=fs.readFileSync(require.resolve('../components/new-algorithm-r-fluency-renderer.tsx'),'utf8');expect(s).toContain("phase==='ready'");expect(s).toContain('setPhase(\'read\')');});
});
