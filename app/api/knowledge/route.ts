import { NextResponse } from 'next/server';
import { knowledgePointName } from '@/lib/domain/functions';
import { getRuntime } from '@/lib/server/runtime';
export const dynamic = 'force-dynamic';
const PAGE_SIZE = 30;
export async function GET(request: Request) {
 const runtime=getRuntime(); await runtime.ready; const state=runtime.repository.load().state; const url=new URL(request.url); const page=Math.max(1,Number(url.searchParams.get('page'))||1); const query=(url.searchParams.get('q')??'').trim().toLocaleLowerCase(); const sources=url.searchParams.getAll('sourceId'); const sort=url.searchParams.get('sort')==='proficiency'?'proficiency':'name'; const learner=state.learners[0];
 const sourceOptions=state.materials.map(m=>({id:m.id,title:m.title}));
 const items=state.knowledgePoints.map(point=>{const materialIds=[...new Set(state.materialAnalyses.filter(a=>a.items.some(i=>i.knowledgePoint.id===point.id)).map(a=>a.materialId))]; const materials=materialIds.map(id=>state.materials.find(m=>m.id===id)).filter((x):x is NonNullable<typeof x>=>Boolean(x)).map(m=>({id:m.id,title:m.title})); const learning=state.learnerKnowledgePoints.find(e=>e.knowledgePointId===point.id&&e.learnerId===learner?.id); const score=learning?Math.round((learning.dimensions.R.fluency+learning.dimensions.P.fluency)/2):null; return {id:point.id,name:knowledgePointName(point),definition:point.sense.definition,wordFamily:point.kind==='word'||point.kind==='phrase'?point.wordFamily:null,score,materials};});
 let filtered=items.filter(item=>(!query||`${item.name} ${item.definition} ${item.materials.map(m=>m.title).join(' ')}`.toLocaleLowerCase().includes(query))&&(!sources.length||sources.some(id=>item.materials.some(m=>m.id===id))));
 filtered.sort((a,b)=>sort==='proficiency'?(b.score??-1)-(a.score??-1)||a.name.localeCompare(b.name):a.name.localeCompare(b.name));
 const totalPages=Math.max(1,Math.ceil(filtered.length/PAGE_SIZE)); const currentPage=Math.min(page,totalPages); const start=(currentPage-1)*PAGE_SIZE; return NextResponse.json({items:filtered.slice(start,start+PAGE_SIZE),sources:sourceOptions,page:currentPage,pageSize:PAGE_SIZE,total:filtered.length,totalPages});
}
