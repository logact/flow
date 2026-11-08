export type ScheduleAxis='r'|'p'|'both';
export type Candidate={wordId:number;axis:ScheduleAxis;dueDate:string|null;review:boolean;graduated:boolean;materialReady:boolean;materialStatus?:'ready'|'pending'|'failed';kind:'review'|'learning'|'new';taskCount?:number;targetR?:number;targetP?:number;scoreR?:number;scoreP?:number;freq?:number|null;freqSource?:string|null;lastTick?:number|null;lastAt?:number|null};
const dayMs=86400000;
export function localDatePlus(date:string,days:number):string { const [y,m,d]=date.split('-').map(Number); const t=new Date(Date.UTC(y,m-1,d+days)); return `${t.getUTCFullYear()}-${String(t.getUTCMonth()+1).padStart(2,'0')}-${String(t.getUTCDate()).padStart(2,'0')}`; }
export function orderCandidates(candidates:Candidate[],currentBookSource:string|null=null):Candidate[] { const rank={review:0,learning:1,new:2} as const; const axisOrder:Record<ScheduleAxis,number>={r:0,p:1,both:-1}; return candidates.filter(c=>!c.graduated&&c.materialReady).slice().sort((a,b)=>{const g=rank[a.kind]-rank[b.kind];if(g)return g;if(a.kind==='new'&&b.kind==='new'){const ordered=orderNewWordCandidates([a as NewWordCandidate,b as NewWordCandidate],currentBookSource);if(ordered[0].wordId!==ordered[1].wordId)return ordered[0].wordId===a.wordId?-1:1;}return (a.dueDate??'9999').localeCompare(b.dueDate??'9999')||a.wordId-b.wordId||axisOrder[a.axis]-axisOrder[b.axis];}); }
export function cooldownReady(input:{tick:number;lastTick:number|null;now:number;lastAt:number|null}):boolean { return input.lastTick===null||input.lastAt===null||input.tick-input.lastTick>=7||input.now-input.lastAt>=20*60*1000; }
export type EmptyReason='today_complete'|'capacity_insufficient'|'cooldown_wait'|'material_pending'|'material_failed'|'scope_empty'|'training_window_closed';
export type ScheduleDecision={kind:'candidate';candidate:Candidate;skippedWordIds:number[]}|{kind:'empty';reason:EmptyReason;nextAvailableAt:number|null;skippedWordIds:number[]};
export function chooseScheduleCandidate(candidates:Candidate[],input:{tick:number;now:number;capacityAvailable:boolean;scopeHasWords:boolean;trainingWindowOpen?:boolean;currentBookSource?:string|null;materialPending?:boolean;materialFailed?:boolean}):ScheduleDecision {
 const ordered=orderCandidates(candidates,input.currentBookSource??null);
 const skippedWordIds=candidates.filter(c=>!c.graduated&&!c.materialReady).map(c=>c.wordId);
 for(const candidate of ordered){if(!cooldownReady({tick:input.tick,lastTick:candidate.lastTick??null,now:input.now,lastAt:candidate.lastAt??null})){skippedWordIds.push(candidate.wordId);continue;}if(input.capacityAvailable&&input.trainingWindowOpen!==false)return {kind:'candidate',candidate,skippedWordIds};}
 if(!input.scopeHasWords)return {kind:'empty',reason:'scope_empty',nextAvailableAt:null,skippedWordIds};
 if(!input.capacityAvailable)return {kind:'empty',reason:'capacity_insufficient',nextAvailableAt:null,skippedWordIds};
 if(input.trainingWindowOpen===false&&ordered.length>0)return {kind:'empty',reason:'training_window_closed',nextAvailableAt:null,skippedWordIds};
 if(ordered.length>0){
  const waiting=ordered.filter(c=>!cooldownReady({tick:input.tick,lastTick:c.lastTick??null,now:input.now,lastAt:c.lastAt??null}));
  if(waiting.length)return {kind:'empty',reason:'cooldown_wait',nextAvailableAt:null,skippedWordIds};
 }
 if(input.materialPending||candidates.some(c=>!c.materialReady&&c.materialStatus!=='failed'))return {kind:'empty',reason:'material_pending',nextAvailableAt:null,skippedWordIds};
 if(input.materialFailed||candidates.some(c=>!c.materialReady&&c.materialStatus==='failed'))return {kind:'empty',reason:'material_failed',nextAvailableAt:null,skippedWordIds};
 return {kind:'empty',reason:'today_complete',nextAvailableAt:null,skippedWordIds};
}
export type Reservation={date:string;count:number;kind:'determined'|'conditional'|'introduction';wordId?:number;axis?:ScheduleAxis|'both'};
export function projectCapacity(input:{today:string;days?:number;capacity:number|((date:string)=>number);completed:Record<string,number>;reservations:Reservation[]}):Array<{date:string;capacity:number;completed:number;determined:number;conditional:number;introduction:number;remaining:number}> { const days=input.days??42; return Array.from({length:days},(_,i)=>{const date=localDatePlus(input.today,i), rs=input.reservations.filter(r=>r.date===date);const determined=rs.filter(r=>r.kind==='determined').reduce((s,r)=>s+r.count,0),conditional=rs.filter(r=>r.kind==='conditional').reduce((s,r)=>s+r.count,0),introduction=rs.filter(r=>r.kind==='introduction').reduce((s,r)=>s+r.count,0),capacity=typeof input.capacity==='number'?input.capacity:input.capacity(date),completed=input.completed[date]??0;return {date,capacity,completed,determined,conditional,introduction,remaining:capacity-completed-determined-conditional-introduction};}); }
export function canAdmitNewWord(input:Parameters<typeof projectCapacity>[0]&{requiredToday:number}):{ok:boolean;shortfall:number;projection:ReturnType<typeof projectCapacity>}{const projection=projectCapacity(input);const today=projection[0];const shortfall=Math.max(0,input.requiredToday-today.remaining);return {ok:shortfall===0&&projection.every(d=>d.remaining>=0),shortfall,projection};}
export function minimumIntroductionTasks(scoreR:number,scoreP:number,requiresConnection=false):number { if(requiresConnection)return 9; const perAxis=(score:number)=>score>=60?1:score>=40?2:score>=20?3:4; return perAxis(scoreR)+perAxis(scoreP); }
export function localReviewDates(startDate:string):string[] { return [1,4,11,41].map(delta=>localDatePlus(startDate,delta)); }
export type NewWordCandidate={wordId:number;targetR:number;targetP:number;scoreR:number;scoreP:number;freq:number|null;freqSource:string|null};
export function orderNewWordCandidates(rows:NewWordCandidate[],currentBookSource:string|null=null):NewWordCandidate[]{const group=(s:string|null)=>s===null?2:s===currentBookSource?0:1;return rows.slice().sort((a,b)=>{if(a.freq===null&&b.freq!==null)return 1;if(b.freq===null&&a.freq!==null)return -1;const ga=group(a.freqSource),gb=group(b.freqSource);if(ga!==gb)return ga-gb;if(ga===1&&a.freqSource!==b.freqSource)return String(a.freqSource).localeCompare(String(b.freqSource));if(a.freq!==null&&b.freq!==null&&a.freq!==b.freq&&a.freqSource===b.freqSource)return b.freq-a.freq;const gap=(x:NewWordCandidate)=>Math.max(0,(x.targetR-x.scoreR)/x.targetR)+Math.max(0,(x.targetP-x.scoreP)/x.targetP);return gap(b)-gap(a)||a.wordId-b.wordId;});}
import type Database from 'better-sqlite3';
import { localCalendarDate } from './new-algorithm-review';
export function loadScheduleCandidates(db:Database.Database, today:string, currentBookSource:string|null=null):Candidate[] {
 const words=db.prepare('SELECT * FROM words').all() as Array<Record<string,any>>;
 const out:Candidate[]=[];
 for(const w of words) if(!w.introduced&&w.score_r===0&&w.score_p===0) {
  const reservation=db.prepare("SELECT local_date FROM capacity_reservations WHERE word_id=? AND axis='both' AND timezone=? AND reservation_kind='introduction' AND status='active' AND local_date<=? ORDER BY local_date LIMIT 1").get(w.id,w.local_timezone,today) as {local_date:string}|undefined;
  if(reservation) { const status=materialStatus(db,w.id,'both','encode'); out.push({wordId:w.id,axis:'both',dueDate:reservation.local_date,review:false,graduated:false,materialReady:status==='ready',materialStatus:status,kind:'new',targetR:w.target_r,targetP:w.target_p,scoreR:w.score_r,scoreP:w.score_p,freq:w.freq,freqSource:w.freq_source,lastTick:w.last_tick_any,lastAt:w.last_ts_any}); }
 }
 for(const w of words) for(const axis of ['r','p'] as const) {
  if(w[`graduated_${axis}`]) continue;
  const review=Boolean(w[`learning_complete_${axis}`]&&w[`review_level_${axis}`]!==null);
  const due=w[`due_at_${axis}`] as string|null;
  const localDue=due?localCalendarDate(Date.parse(due),w.local_timezone):null;
  if(due&&localDue&&localDue<=today) { const status=materialStatus(db,w.id,axis,review?'fluency':stageFor(w[`score_${axis}`])); out.push({wordId:w.id,axis,dueDate:localDue,review,graduated:false,materialReady:status==='ready',materialStatus:status,kind:review?'review':'learning',lastTick:w.last_tick_any,lastAt:w.last_ts_any}); }
 }
 return orderCandidates(out.filter(c=>c.materialReady),currentBookSource).concat(orderCandidates(out.filter(c=>!c.materialReady),currentBookSource));
}
function stageFor(score:number):'choice'|'cued'|'free'|'fluency' { return score<20?'choice':score<40?'cued':score<60?'free':'fluency'; }
function materialStatus(db:Database.Database,wordId:number,axis:ScheduleAxis,stage:string):'ready'|'pending'|'failed' { const rows=db.prepare("SELECT m.status,m.usage_count FROM materials m JOIN words w ON w.id=m.word_id WHERE m.word_id=? AND m.axis=? AND m.stage=? AND m.meaning_version=w.meaning_version ORDER BY m.version DESC").all(wordId,axis,stage) as Array<{status:string;usage_count:number}>; if(rows.some(x=>x.status==='ready'&&x.usage_count===0))return 'ready'; if(rows.some(x=>x.status==='preparing'))return 'pending'; if(rows.length&&rows.every(x=>x.status==='failed'))return 'failed'; return 'pending'; }
function trainingWindowOpen(db:Database.Database,now:number,timezone:string):boolean { const start=db.prepare('SELECT value FROM meta WHERE key=?').get(`training_window_start:${timezone}`) as {value:string}|undefined; const end=db.prepare('SELECT value FROM meta WHERE key=?').get(`training_window_end:${timezone}`) as {value:string}|undefined; if(!start||!end)return false; const parts=new Intl.DateTimeFormat('en-US',{timeZone:timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now); const val=(name:string)=>Number(parts.find(x=>x.type===name)?.value); const minute=val('hour')*60+val('minute'),to=(value:string)=>Number(value.slice(0,2))*60+Number(value.slice(3,5)); return minute>=to(start.value)&&minute<to(end.value); }
export function getScheduleDecision(db:Database.Database,input:{now:number;today:string;timezone:string;currentBookSource?:string|null;wordIds?:number[]}):ScheduleDecision {
 if(!Number.isSafeInteger(input.now)||input.now<0)throw new Error('Invalid scheduler timestamp');
 const allWords=db.prepare('SELECT * FROM words').all() as Array<Record<string,any>>;
 const scopedWords=input.wordIds?allWords.filter(w=>input.wordIds!.includes(w.id)):allWords;
 const ids=new Set(scopedWords.map(w=>w.id));
 let candidates=loadScheduleCandidates(db,input.today,input.currentBookSource).filter(c=>ids.has(c.wordId));
 const tickRow=db.prepare("SELECT value FROM meta WHERE key='global_tick'").get() as {value:string}|undefined;
 const projection=readCapacityProjection(db,input.today,input.timezone);
 const remaining=projection[0]?.remaining??0;
 if(remaining<=0)candidates=candidates.filter(c=>remaining+activeCandidateReservationCount(db,c,input.today,input.timezone)>0);
 const decision=chooseScheduleCandidate(candidates,{tick:Number(tickRow?.value??0),now:input.now,capacityAvailable:remaining>0||candidates.length>0,scopeHasWords:scopedWords.length>0,trainingWindowOpen:trainingWindowOpen(db,input.now,input.timezone)});
 if(decision.kind==='candidate')return decision;
 if(decision.reason==='today_complete'){
  const future=scopedWords.flatMap(w=>['r','p'].flatMap(axis=>{
   if(w[`graduated_${axis}`])return [];
   const due=w[`due_at_${axis}`] as string|null;
   if(!due||!Number.isFinite(Date.parse(due))||Date.parse(due)<=input.now)return [];
   const timezone=String(w.local_timezone), localDue=localCalendarDate(Date.parse(due),timezone);
   const review=Boolean(w[`learning_complete_${axis}`]&&w[`review_level_${axis}`]!==null);
   if(materialStatus(db,w.id,axis,review?'fluency':stageFor(w[`score_${axis}`]))!=='ready')return [];
   const reservation=db.prepare("SELECT 1 FROM capacity_reservations WHERE word_id=? AND axis=? AND local_date=? AND timezone=? AND status='active' AND reservation_kind IN ('determined','conditional') LIMIT 1").get(w.id,axis,localDue,timezone);
   if(!reservation)return [];
   return [Date.parse(due)];
  })).filter(x=>Number.isFinite(x));
  if(future.length)return {...decision,nextAvailableAt:Math.min(...future)};
 }
 return decision;
}
function activeCandidateReservationCount(db:Database.Database,candidate:Candidate,date:string,timezone:string):number { const row=db.prepare("SELECT COALESCE(SUM(task_count),0) n FROM capacity_reservations WHERE word_id=? AND axis=? AND local_date=? AND timezone=? AND status='active' AND ((axis='both' AND reservation_kind='introduction') OR (axis IN ('r','p') AND reservation_kind IN ('determined','conditional')))").get(candidate.wordId,candidate.axis,date,timezone) as {n:number}; return row.n; }
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
export function admitReservedNewWord(db:Database.Database,input:{wordId:number;today:string;timezone:string;scoreR:number;scoreP:number;requiresConnection:boolean;completionDateR:string;completionDateP:string;remainingMinutes:Record<string,number>;minutesRequired:number}):{ok:boolean;reason?:string;requiredTasks:number}{
 const requiredTasks=minimumIntroductionTasks(input.scoreR,input.scoreP,input.requiresConnection);
 return db.transaction(()=>{
  const word=db.prepare('SELECT introduced,score_r,score_p FROM words WHERE id=?').get(input.wordId) as {introduced:number;score_r:number;score_p:number}|undefined;
  if(!word||word.score_r!==input.scoreR||word.score_p!==input.scoreP||(input.requiresConnection?Boolean(word.introduced)||input.scoreR!==0||input.scoreP!==0:!word.introduced))return {ok:false,reason:'candidate_changed',requiredTasks};
  const stages=input.requiresConnection?[['both','encode'] as const]:[['r',stageFor(input.scoreR)],['p',stageFor(input.scoreP)] ] as const;
  if(stages.some(([axis,stage])=>materialStatus(db,input.wordId,axis,stage)!=='ready'))return {ok:false,reason:'material_unavailable',requiredTasks};
  const own=db.prepare("SELECT local_date,task_count,reservation_kind,word_id,axis FROM capacity_reservations WHERE word_id=? AND timezone=? AND status='active'").all(input.wordId,input.timezone) as Array<{local_date:string;task_count:number;reservation_kind:Reservation['kind'];word_id:number;axis:ScheduleAxis}>;
  if(own.some(x=>x.reservation_kind==='determined'))return {ok:false,reason:'candidate_changed',requiredTasks};
  const projection=readCapacityProjection(db,input.today,input.timezone).map(d=>({...d,remaining:d.remaining+own.filter(x=>x.local_date===d.date).reduce((n,x)=>n+x.task_count,0)}));
  const needMinutes=Math.max(0,requiredTasks-1)*20;
  if(!projection[0]||projection[0].remaining<requiredTasks)return {ok:false,reason:'capacity_today',requiredTasks};
  if((input.remainingMinutes[input.today]??0)<Math.max(needMinutes,input.minutesRequired))return {ok:false,reason:'time_remaining',requiredTasks};
  if(projection.some(day=>day.remaining<0))return {ok:false,reason:'capacity_future',requiredTasks};
  const forecasts=[{axis:'r' as const,start:input.completionDateR},{axis:'p' as const,start:input.completionDateP}].flatMap(x=>localReviewDates(x.start).map(date=>({axis:x.axis,date,count:1,kind:'conditional' as const})));
  const projected=projection.map(d=>({...d,remaining:d.remaining-forecasts.filter(x=>x.date===d.date).length}));
  if(projected.some(d=>d.remaining<0))return {ok:false,reason:'capacity_future',requiredTasks};
  // Only reservations inside today's rolling 42-date view participate in this admission check.
  db.prepare("UPDATE capacity_reservations SET status='cancelled' WHERE word_id=? AND timezone=? AND status='active' AND reservation_kind IN ('introduction','conditional')").run(input.wordId,input.timezone);
  const put=db.prepare(`INSERT INTO capacity_reservations(reservation_id,word_id,axis,local_date,timezone,reservation_kind,task_count,status) VALUES(?,?,?,?,?,?,?,'active') ON CONFLICT(word_id,axis,local_date,timezone,reservation_kind) DO UPDATE SET reservation_id=excluded.reservation_id,task_count=excluded.task_count,status='active'`);
  put.run(`intro:${input.wordId}`,input.wordId,'both',input.today,input.timezone,'introduction',requiredTasks);
  for(const x of forecasts)put.run(`review:${input.wordId}:${x.axis}:${x.kind}:${x.date}`,input.wordId,x.axis,x.date,input.timezone,x.kind,x.count);
  return {ok:true,requiredTasks};
 })();
}
