import { NextResponse } from 'next/server';
import { knowledgePointName } from '@/lib/domain/functions';
import { getRuntime } from '@/lib/server/runtime';
export const dynamic='force-dynamic';
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){const {id}=await params;const runtime=getRuntime();await runtime.ready;const state=runtime.repository.load().state;const material=state.materials.find(x=>x.id===id);if(!material)return NextResponse.json({reason:'material_not_found'},{status:404});const analysis=state.materialAnalyses.filter(x=>x.materialId===id).at(-1);if(!analysis)return NextResponse.json({reason:'analysis_not_found'},{status:404});return NextResponse.json({analysis:{id:analysis.id,status:analysis.status,items:analysis.items.map(x=>({knowledgePointId:x.knowledgePoint.id,lemma:knowledgePointName(x.knowledgePoint),definition:x.knowledgePoint.sense.definition}))}})}
