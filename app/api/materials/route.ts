import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { createMaterial } from '@/lib/domain/functions';
import { extractTextFromFile } from '@/lib/application/text-extraction';
import { getDemoLearner, getRuntime } from '@/lib/server/runtime';
import { BNC_COCA_L6 } from '@/lib/server/vocabulary-list-repository';

export const dynamic = 'force-dynamic';

/** 材料列表及其最新分析摘要。 */
export async function GET(request: Request) {
  const runtime = getRuntime();
  await runtime.ready;
  const state = runtime.repository.load().state;
  const includeArchived = new URL(request.url).searchParams.get('includeArchived') === 'true';
  const materials = state.materials.filter(material => includeArchived || !material.archivedAt).map((material) => {
    const analyses = state.materialAnalyses.filter((item) => item.materialId === material.id);
    const latest = analyses.at(-1) ?? null;
    return {
      id: material.id,
      title: material.title,
      filename: material.filename,
      format: material.format,
      createdAt: material.createdAt,
      archivedAt: material.archivedAt ?? null,
      analysis: latest
        ? {
            id: latest.id,
            status: latest.status,
            progress: latest.status === 'analyzed' ? null : latest.progress ?? null,
            errors: latest.status === 'failed' ? latest.errors : [],
            itemCount: latest.items.length,
            unmatchedCount: latest.unmatchedItems.length,
            candidates: latest.status === 'analyzed' ? (latest.candidates ?? []).map(candidate => ({ lemma: candidate.lemma, status: candidate.status, occurrenceCount: candidate.occurrences.length })) : [],
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

/** 只保存材料原文；分析记录仅在用户显式启动分析时创建。 */
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

  const filename=body.filename?.trim()||'pasted-material.txt'; const lowerFilename=filename.toLowerCase(); const format=lowerFilename.endsWith('.pdf')?'pdf':/\.(md|markdown)$/.test(lowerFilename)?'markdown':'txt';
  const rawFile=body.base64?new Uint8Array(Buffer.from(body.base64,'base64')):undefined;
  let extractedText=body.text??''; let extractionMetadata:Record<string,unknown>={extractor:'provided'}; if(rawFile){try{const extracted=await extractTextFromFile(format,rawFile);extractedText=extracted.text;extractionMetadata=extracted.metadata;}catch{return NextResponse.json({reason:'extraction_failed',message:format==='pdf'?'PDF 解析失败，请确认文件未损坏后重试。':'文件读取失败，请确认文件编码为 UTF-8。'}, {status:400});}}
  if(!extractedText.trim())return NextResponse.json({reason:'empty_extracted_text',message:format==='pdf'?'未能从 PDF 提取到文字。请上传可选择文字的 PDF，或改用 TXT/Markdown。':'文件内容为空。'}, {status:400});
  const now=new Date().toISOString(), id=crypto.randomUUID();
  const material=createMaterial({id,learnerId:learner.id,title:body.title?.trim()||filename.replace(/\.[^.]+$/,''),filename,format,mimeType:format==='pdf'?'application/pdf':format==='markdown'?'text/markdown':'text/plain',checksum:createHash('sha256').update(rawFile??Buffer.from(extractedText)).digest('hex'),storageKey:null,extractedText,extractionMetadata,now});
  await runtime.repository.saveMaterial(material);
  return NextResponse.json({
    material: {
      id: material.id,
      title: material.title,
      filename: material.filename,
      format: material.format,
    },
    analysis: null,
  });
}
