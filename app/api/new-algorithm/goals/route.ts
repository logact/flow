import { NextResponse } from 'next/server';
import { getNewAlgorithmDb } from '../../../../lib/new-algorithm-runtime-db';
import { confirmNewAlgorithmMeaning, importNewAlgorithmWords, reserveIntroductionCapacity, setDailyAvailability } from '../../../../lib/new-algorithm-import';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function localDate(now: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  const p=(type:string)=>parts.find(x=>x.type===type)?.value ?? '';
  return `${p('year')}-${p('month')}-${p('day')}`;
}

export async function GET(request: Request) {
  try {
    const db=getNewAlgorithmDb(); const url=new URL(request.url); const timezone=url.searchParams.get('timezone');
    if (!timezone) return NextResponse.json({error:'timezone is required'},{status:400});
    const date=localDate(Date.now(),timezone);
    const capacity=db.prepare('SELECT capacity,completed FROM daily_capacity WHERE local_date=? AND timezone=?').get(date,timezone) ?? null;
    const words=db.prepare('SELECT id,term,meaning,score_r,score_p,introduced,due_at_r,due_at_p FROM words ORDER BY id DESC LIMIT 200').all();
    const ready=(db.prepare("SELECT count(*) n FROM materials WHERE status='ready'").get() as {n:number}).n;
    return NextResponse.json({date,timezone,capacity,words,readyMaterials:ready});
  } catch (e) { return NextResponse.json({error:(e as Error).message},{status:400}); }
}

export async function POST(request: Request) {
  try {
    const db=getNewAlgorithmDb(); const input=await request.json();
    if(input.action==='configure') {
      const now=Date.now(); const timezone=String(input.timezone || '');
      setDailyAvailability(db,{timezone,localDate:localDate(now,timezone),capacity:Number(input.capacity),windowStart:String(input.windowStart),windowEnd:String(input.windowEnd)});
      return NextResponse.json({ok:true});
    }
    if(input.action==='import') {
      const now=Date.now(); const timezone=String(input.timezone || '');
      if (!timezone || !Array.isArray(input.words)) return NextResponse.json({error:'timezone and words are required'},{status:400});
      const ids=importNewAlgorithmWords(db,input.words.map((word:Record<string,unknown>)=>({...word,timezone})),now,
        (tx,candidates,createdAt,tz)=>reserveIntroductionCapacity(tx,candidates,createdAt,tz));
      return NextResponse.json({ids});
    }
    return NextResponse.json({error:'Unknown action'},{status:400});
  } catch (e) { const message=(e as Error).message; return NextResponse.json({error:message},{status:message==='CAPACITY_INSUFFICIENT'?409:400}); }
}

export async function PATCH(request: Request) {
  try {
    const db=getNewAlgorithmDb(); const body=await request.json();
    if(!Number.isSafeInteger(body.wordId) || typeof body.meaning!=='string') return NextResponse.json({error:'Invalid meaning update'},{status:400});
    const version=confirmNewAlgorithmMeaning(db,body.wordId,body.meaning);
    return NextResponse.json({meaningVersion:version});
  } catch(e) { return NextResponse.json({error:(e as Error).message},{status:400}); }
}
