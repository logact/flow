export type ScheduleAxis='r'|'p'|'both';
export type Candidate={wordId:number;axis:ScheduleAxis;dueDate:string|null;review:boolean;graduated:boolean;materialReady:boolean;kind:'review'|'learning'|'new';taskCount?:number};
const dayMs=86400000;
export function localDatePlus(date:string,days:number):string { const [y,m,d]=date.split('-').map(Number); const t=new Date(Date.UTC(y,m-1,d+days)); return `${t.getUTCFullYear()}-${String(t.getUTCMonth()+1).padStart(2,'0')}-${String(t.getUTCDate()).padStart(2,'0')}`; }
export function orderCandidates(candidates:Candidate[]):Candidate[] { const rank={review:0,learning:1,new:2} as const; const axisOrder:Record<ScheduleAxis,number>={r:0,p:1,both:-1}; return candidates.filter(c=>!c.graduated&&c.materialReady).slice().sort((a,b)=>rank[a.kind]-rank[b.kind] || (a.dueDate??'9999').localeCompare(b.dueDate??'9999') || a.wordId-b.wordId || axisOrder[a.axis]-axisOrder[b.axis]); }
export function cooldownReady(input:{tick:number;lastTick:number|null;now:number;lastAt:number|null}):boolean { return input.lastTick===null||input.lastAt===null||input.tick-input.lastTick>=7||input.now-input.lastAt>=20*60*1000; }
export type Reservation={date:string;count:number;kind:'determined'|'conditional'|'introduction';wordId?:number;axis?:ScheduleAxis|'both'};
export function projectCapacity(input:{today:string;days?:number;capacity:number|((date:string)=>number);completed:Record<string,number>;reservations:Reservation[]}):Array<{date:string;capacity:number;completed:number;determined:number;conditional:number;introduction:number;remaining:number}> { const days=input.days??42; return Array.from({length:days},(_,i)=>{const date=localDatePlus(input.today,i), rs=input.reservations.filter(r=>r.date===date);const determined=rs.filter(r=>r.kind==='determined').reduce((s,r)=>s+r.count,0),conditional=rs.filter(r=>r.kind==='conditional').reduce((s,r)=>s+r.count,0),introduction=rs.filter(r=>r.kind==='introduction').reduce((s,r)=>s+r.count,0),capacity=typeof input.capacity==='number'?input.capacity:input.capacity(date),completed=input.completed[date]??0;return {date,capacity,completed,determined,conditional,introduction,remaining:capacity-completed-determined-conditional-introduction};}); }
export function canAdmitNewWord(input:Parameters<typeof projectCapacity>[0]&{requiredToday:number}):{ok:boolean;shortfall:number;projection:ReturnType<typeof projectCapacity>}{const projection=projectCapacity(input);const today=projection[0];const shortfall=Math.max(0,input.requiredToday-today.remaining);return {ok:shortfall===0&&projection.every(d=>d.remaining>=0),shortfall,projection};}
export function minimumIntroductionTasks(scoreR:number,scoreP:number,requiresConnection=false):number { if(requiresConnection)return 9; const perAxis=(score:number)=>score>=60?1:score>=40?2:score>=20?3:4; return perAxis(scoreR)+perAxis(scoreP); }
export function localReviewDates(startDate:string):string[] { return [1,4,11,41].map(delta=>localDatePlus(startDate,delta)); }
import type Database from 'better-sqlite3';
import { localCalendarDate } from './new-algorithm-review';
export function loadScheduleCandidates(db:Database.Database, today:string):Candidate[] {
 const words=db.prepare('SELECT * FROM words').all() as Array<Record<string,any>>;
 const out:Candidate[]=[];
 for(const w of words) if(!w.introduced&&w.score_r===0&&w.score_p===0) {
  const reservation=db.prepare("SELECT local_date FROM capacity_reservations WHERE word_id=? AND axis='both' AND reservation_kind='introduction' AND status='active' AND local_date<=? ORDER BY local_date LIMIT 1").get(w.id,today) as {local_date:string}|undefined;
  if(reservation&&hasReadyMaterial(db,w.id,'both','encode')) out.push({wordId:w.id,axis:'both',dueDate:reservation.local_date,review:false,graduated:false,materialReady:true,kind:'new'});
 }
 for(const w of words) for(const axis of ['r','p'] as const) {
  if(w[`graduated_${axis}`]) continue;
  const review=Boolean(w[`learning_complete_${axis}`]&&w[`review_level_${axis}`]!==null);
  const due=w[`due_at_${axis}`] as string|null;
  const localDue=due?localCalendarDate(Date.parse(due),w.local_timezone):null;
  if(due&&localDue&&localDue<=today) out.push({wordId:w.id,axis,dueDate:localDue,review,graduated:false,materialReady:hasReadyMaterial(db,w.id,axis,review?'fluency':stageFor(w[`score_${axis}`])),kind:review?'review':'learning'});
 }
 return orderCandidates(out);
}
function stageFor(score:number):'choice'|'cued'|'free'|'fluency' { return score<20?'choice':score<40?'cued':score<60?'free':'fluency'; }
function hasReadyMaterial(db:Database.Database,wordId:number,axis:ScheduleAxis,stage:string):boolean { return Boolean(db.prepare("SELECT 1 FROM materials WHERE word_id=? AND axis=? AND stage=? AND status='ready' AND usage_count=0 LIMIT 1").get(wordId,axis,stage)); }
/** Replaces only the selected axis's active forecasts; reservation IDs remain stable for identical projections. */
export function reconcileAxisReservations(db:Database.Database,input:{wordId:number;axis:ScheduleAxis;today:string;timezone:string;determinedDate:string|null;conditionalDates:string[]}):void {
 db.transaction(()=>{
  db.prepare("UPDATE capacity_reservations SET status='cancelled' WHERE word_id=? AND axis=? AND reservation_kind IN ('determined','conditional') AND status='active'").run(input.wordId,input.axis);
  const put=db.prepare(`INSERT INTO capacity_reservations(reservation_id,word_id,axis,local_date,timezone,reservation_kind,task_count,status) VALUES(?,?,?,?,?,?,1,'active') ON CONFLICT(word_id,axis,local_date,timezone,reservation_kind) DO UPDATE SET status='active',task_count=1`);
  if(input.determinedDate) put.run(`review:${input.wordId}:${input.axis}:determined:${input.determinedDate}`,input.wordId,input.axis,input.determinedDate,input.timezone,'determined');
  for(const date of input.conditionalDates) put.run(`review:${input.wordId}:${input.axis}:conditional:${date}`,input.wordId,input.axis,date,input.timezone,'conditional');
 })();
}
export function readCapacityProjection(db:Database.Database,today:string,timezone:string) { const rows=db.prepare("SELECT local_date,capacity,completed FROM daily_capacity WHERE timezone=? AND local_date BETWEEN ? AND ?").all(timezone,today,localDatePlus(today,41)) as Array<{local_date:string;capacity:number;completed:number}>; const res=db.prepare("SELECT local_date,task_count,reservation_kind,word_id,axis FROM capacity_reservations WHERE timezone=? AND local_date BETWEEN ? AND ? AND status='active'").all(timezone,today,localDatePlus(today,41)) as Array<{local_date:string;task_count:number;reservation_kind:Reservation['kind'];word_id:number;axis:ScheduleAxis|'both'}>; const cap=new Map(rows.map(x=>[x.local_date,x])); return projectCapacity({today,capacity:d=>cap.get(d)?.capacity??0,completed:Object.fromEntries(rows.map(x=>[x.local_date,x.completed])),reservations:res.map(x=>({date:x.local_date,count:x.task_count,kind:x.reservation_kind,wordId:x.word_id,axis:x.axis}))}); }
