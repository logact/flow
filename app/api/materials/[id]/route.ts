import { NextResponse } from 'next/server';
import { knowledgePointName } from '@/lib/domain/functions';
import { getRuntime } from '@/lib/server/runtime';
export const dynamic='force-dynamic';
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){const {id}=await params;const runtime=getRuntime();await runtime.ready;const state=runtime.repository.load().state;const material=state.materials.find(x=>x.id===id);if(!material)return NextResponse.json({reason:'material_not_found'},{status:404});const materialView={id:material.id,title:material.title,filename:material.filename,format:material.format,createdAt:material.createdAt,archivedAt:material.archivedAt??null};const analysis=state.materialAnalyses.filter(x=>x.materialId===id).at(-1);if(!analysis)return NextResponse.json({material:materialView,analysis:null});return NextResponse.json({material:materialView,analysis:{id:analysis.id,status:analysis.status,createdAt:analysis.createdAt,errors:analysis.errors,items:analysis.items.map(x=>({knowledgePointId:x.knowledgePoint.id,lemma:knowledgePointName(x.knowledgePoint),definition:x.knowledgePoint.sense.definition,partOfSpeech:x.knowledgePoint.sense.partOfSpeech,occurrenceCount:x.occurrences.length}))}})}

export async function PATCH(request:Request,{params}:{params:Promise<{id:string}>}) {
  const {id}=await params;
  const body=await request.json().catch(()=>null) as {archived?:unknown}|null;
  if(typeof body?.archived!=='boolean') return NextResponse.json({reason:'invalid_input',message:'archived 必须是布尔值'},{status:400});
  const runtime=getRuntime(); await runtime.ready;
  const {state,revision}=runtime.repository.load();
  const material=state.materials.find(item=>item.id===id);
  if(!material) return NextResponse.json({reason:'material_not_found'},{status:404});
  const updated={...material,archivedAt:body.archived?new Date().toISOString():null};
  runtime.repository.save({...state,materials:state.materials.map(item=>item.id===id?updated:item)},revision);
  return NextResponse.json({material:{id:updated.id,archivedAt:updated.archivedAt}});
}
