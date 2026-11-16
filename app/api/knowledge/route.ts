import { NextResponse } from 'next/server';
import { knowledgePointName } from '@/lib/domain/functions';
import { getRuntime } from '@/lib/server/runtime';
export const dynamic = 'force-dynamic';
const PAGE_SIZE = 30;
export async function GET(request: Request) {
 const runtime=getRuntime(); await runtime.ready; const state=runtime.repository.load().state; const url=new URL(request.url); const page=Math.max(1,Number(url.searchParams.get('page'))||1); const query=(url.searchParams.get('q')??'').trim().toLocaleLowerCase(); const learner=state.learners[0];
 const items=state.knowledgePoints.map(point=>{const mids=new Set(state.materialAnalyses.flatMap(a=>a.items.some(i=>i.knowledgePoint.id===point.id)?[a.materialId]:[])); const materials=[...mids].map(id=>state.materials.find(m=>m.id===id)?.title).filter((x):x is string=>Boolean(x)); const learning=state.learnerKnowledgePoints.find(e=>e.knowledgePointId===point.id&&e.learnerId===learner?.id); return {id:point.id,name:knowledgePointName(point),definition:point.sense.definition,score:learning?Math.round((learning.dimensions.R.fluency+learning.dimensions.P.fluency)/2):null,materials};}).sort((a,b)=>a.name.localeCompare(b.name));
 const filtered=query?items.filter(item=>`${item.name} ${item.definition} ${item.materials.join(' ')}`.toLocaleLowerCase().includes(query)):items;
 const totalPages=Math.max(1,Math.ceil(filtered.length/PAGE_SIZE)); const currentPage=Math.min(page,totalPages); const start=(currentPage-1)*PAGE_SIZE; return NextResponse.json({items:filtered.slice(start,start+PAGE_SIZE),page:currentPage,pageSize:PAGE_SIZE,total:filtered.length,totalPages});
}
