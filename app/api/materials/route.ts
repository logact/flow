import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { createMaterial } from '@/lib/domain/functions';
import { extractTextFromFile } from '@/lib/application/text-extraction';
import { getDemoLearner, getRuntime } from '@/lib/server/runtime';
import { BNC_COCA_L6 } from '@/lib/server/vocabulary-list-repository';

export const dynamic = 'force-dynamic';

/** 材料列表及其最新分析摘要。 */
export async function GET() {
  const runtime = getRuntime();
  await runtime.ready;
  const state = runtime.repository.load().state;
  const materials = state.materials.map((material) => {
    const analyses = state.materialAnalyses.filter((item) => item.materialId === material.id);
    const latest = analyses.at(-1) ?? null;
    return {
      id: material.id,
      title: material.title,
      filename: material.filename,
      format: material.format,
      createdAt: material.createdAt,
      analysis: latest
        ? {
            id: latest.id,
            status: latest.status,
            itemCount: latest.items.length,
            unmatchedCount: latest.unmatchedItems.length,
            frequencyRank: latest.items.reduce((best, item) => {
              const classification = state.knowledgePointVocabularyClassifications.find(x => x.knowledgePointId === item.knowledgePoint.id && x.list.id === BNC_COCA_L6.id && x.list.version === BNC_COCA_L6.version);
              const family = runtime.vocabularyIndex.lookup(item.knowledgePoint.kind === 'word' || item.knowledgePoint.kind === 'phrase' ? item.knowledgePoint.lemma : '');
              const rank = classification ? Number.parseInt(classification.band, 10) : family ? Number.parseInt(family.band, 10) : Number.POSITIVE_INFINITY;
              return Math.min(best, rank);
            }, Number.POSITIVE_INFINITY),
            frequentTermCount: latest.items.reduce((count, item) => {
              const classification = state.knowledgePointVocabularyClassifications.find(x => x.knowledgePointId === item.knowledgePoint.id && x.list.id === BNC_COCA_L6.id && x.list.version === BNC_COCA_L6.version);
              const family = runtime.vocabularyIndex.lookup(item.knowledgePoint.kind === 'word' || item.knowledgePoint.kind === 'phrase' ? item.knowledgePoint.lemma : '');
              const rank = classification ? Number.parseInt(classification.band, 10) : family ? Number.parseInt(family.band, 10) : Number.POSITIVE_INFINITY;
              return count + (rank <= 2 ? 1 : 0);
            }, 0),
            createdAt: latest.createdAt,
          }
        : null,
    };
  });
  return NextResponse.json({ materials });
}

/** 保存材料原文并建立待分析记录；分析由用户后续显式触发。 */
export async function POST(request: Request) {
  const runtime = getRuntime();
  await runtime.ready;
  const learner = await getDemoLearner();
  const body = (await request.json().catch(() => null)) as {
    filename?: string;
    title?: string;
    text?: string;
    base64?: string;
  } | null;
  if (!body || (!body.text && !body.base64)) {
    return NextResponse.json({ reason: 'invalid_input', message: '需要 text 或 base64 内容' }, { status: 400 });
  }

  const filename=body.filename?.trim()||'pasted-material.txt'; const format=filename.toLowerCase().endsWith('.pdf')?'pdf':filename.toLowerCase().endsWith('.md')?'markdown':'txt';
  const rawFile=body.base64?new Uint8Array(Buffer.from(body.base64,'base64')):undefined;
  let extractedText=body.text??''; let extractionMetadata:Record<string,unknown>={extractor:'provided'}; if(rawFile){try{const extracted=await extractTextFromFile(format,rawFile);extractedText=extracted.text;extractionMetadata=extracted.metadata;}catch{return NextResponse.json({reason:'extraction_failed'}, {status:400});}}
  if(!extractedText.trim())return NextResponse.json({reason:'invalid_input'}, {status:400});
  const now=new Date().toISOString(), id=crypto.randomUUID();
  const material=createMaterial({id,learnerId:learner.id,title:body.title?.trim()||filename.replace(/\.[^.]+$/,''),filename,format,mimeType:format==='pdf'?'application/pdf':format==='markdown'?'text/markdown':'text/plain',checksum:createHash('sha256').update(rawFile??Buffer.from(extractedText)).digest('hex'),storageKey:null,extractedText,extractionMetadata,now});
  await runtime.repository.saveMaterial(material);
  await runtime.repository.saveMaterialAnalysis(id,{id:crypto.randomUUID(),materialId:id,analyzerVersion:'web-v1',createdAt:now,status:'pending',items:[],unmatchedItems:[],errors:[],completedAt:null});
  return NextResponse.json({
    material: {
      id: material.id,
      title: material.title,
      filename: material.filename,
      format: material.format,
    },
    analysis: {id: null,status:'pending',itemCount:0,unmatchedCount:0},
  });
}
