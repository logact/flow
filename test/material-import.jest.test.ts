/// <reference types="jest" />

/**
 * S04 导入并分析材料的应用用例测试。
 * 使用内存 Repository 验证编排：
 * - 原始文件（pdf/txt/markdown）由应用层提取文本，createMaterial → analyzeMaterial 后一次性保存。
 * - 已提取文本路径直接使用调用方文本，不再读取原始文件。
 * - 格式不支持、提取失败、输入校验失败、分析失败时均不保存半成品。
 * 不验证：OCR（仅记录无文本层页码）、SQLite 实现的外部存储。
 */

import PDFDocument from 'pdfkit';
import { loadSenseInventoryFromFile } from '../lib/application/sense-inventory';
import { importMaterialUseCase } from '../lib/application/material-import';
import { silentLogger } from './helpers/silent-logger';
import type {
  AnalyzedMaterialAnalysis,
  InventorySense,
  MaterialRepository,
  SenseDisambiguationItem,
  SenseDisambiguator,
  SenseInventory,
} from '../lib/application/ports';
import { markdownToPlainText } from '../lib/application/text-extraction';
import { validateLearningState } from '../lib/domain/invariants';
import type * as Model from '../lib/domain/model';

const at = {
  imported: '2026-11-12T00:20:00.000Z',
};
const learnerId = 'learner-1';
const analyzerVersion = 'material-analyzer-v1';

const learner: Model.Learner = {
  id: learnerId,
  currentVocabulary: null,
  dailyTaskCapacity: 5,
  timezone: 'Asia/Shanghai',
  createdAt: at.imported,
  updatedAt: at.imported,
};

const markdownSource = [
  '# How Teams Adapt',
  '',
  'Contemporary teams work in a world where **digital tools** are ubiquitous.',
  '',
  '- When a project changes, a [deliberate](https://example.com) response is more useful than a rushed one.',
  '',
  '> A resilient team learns from the setback, adjusts its plan, and keeps moving.',
  '',
].join('\n');

const plainSource = [
  '\uFEFFContemporary teams work in a world where digital tools are ubiquitous.',
  '',
  'When a project changes, a deliberate response is more useful than a rushed one.',
  'A resilient team learns from the setback, adjusts its plan, and keeps moving.',
].join('\r\n');

function createPdfBuffer(lines: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    for (const line of lines) doc.text(line);
    doc.end();
  });
}

/** 内存 Repository：记录每次写入，并把产物放进状态供 validateLearningState 校验。 */
class InMemoryMaterialRepository implements MaterialRepository {
  readonly saves: Array<{ material: Model.Material; analysis: AnalyzedMaterialAnalysis }> = [];

  constructor(private readonly state: Model.LearningState) {}

  async saveMaterialWithAnalysis(
    material: Model.Material,
    analysis: AnalyzedMaterialAnalysis,
  ): Promise<void> {
    this.saves.push({ material, analysis });
    this.state.materials.push(material);
    this.state.materialAnalyses.push(analysis);
  }
}

function createState(): Model.LearningState {
  return {
    learners: [learner],
    vocabularyAssessments: [],
    vocabularyAssessmentTasks: [],
    vocabularyAssessmentAttempts: [],
    materials: [],
    materialAnalyses: [],
    goals: [],
    goalMaterials: [],
    knowledgePoints: [],
    knowledgePointVocabularyClassifications: [],
    goalKnowledgePoints: [],
    goalKnowledgePointSources: [],
    learnerKnowledgePoints: [],
    studyPlans: [],
    tasks: [],
    attempts: [],
  };
}

function setup() {
  const state = createState();
  const repository = new InMemoryMaterialRepository(state);
  return { state, repository };
}

function baseInput(overrides: Partial<Parameters<typeof importMaterialUseCase>[1]>) {
  return {
    materialId: 'material-1',
    analysisId: 'analysis-1',
    learnerId,
    filename: 'how-teams-adapt.md',
    analyzerVersion,
    now: at.imported,
    ...overrides,
  };
}

function expectOk(result: Awaited<ReturnType<typeof importMaterialUseCase>>) {
  if (!result.ok) throw new Error(`期望导入成功，实际失败：${result.reason}`);
  return result;
}

function analysisItemIds(analysis: AnalyzedMaterialAnalysis): string[] {
  return analysis.items.map((item) => item.knowledgePoint.id);
}

describe('S04 导入并分析材料', () => {
  test('markdown 原始文件：应用层提取文本并分析，材料与分析一次性保存', async () => {
    const { state, repository } = setup();
    const rawFile = Buffer.from(markdownSource, 'utf8');

    const result = await importMaterialUseCase(
      {
        repository,
        senseInventory: {
          lookup: (lemma) => (lemma === 'contemporary'
            ? [{ id: 'wn31:a:02951280', pos: 'adjective', gloss: 'characteristic of the present' }]
            : []),
        },
        logger: silentLogger,
      },
      baseInput({ rawFile }),
    );

    const { material, analysis } = expectOk(result);
    expect(material.id).toBe('material-1');
    expect(material.learnerId).toBe(learnerId);
    expect(material.title).toBe('how-teams-adapt');
    expect(material.filename).toBe('how-teams-adapt.md');
    expect(material.format).toBe('markdown');
    expect(material.mimeType).toBe('text/markdown');
    expect(material.storageKey).toBe(null);
    expect(material.extractionMetadata).toEqual(
      expect.objectContaining({ extractor: 'markdown', encoding: 'utf-8' }),
    );
    // Markdown 排版语法被剥离，自然语言内容保留。
    expect(material.extractedText).toContain('Contemporary teams work in a world where digital tools are ubiquitous.');
    expect(material.extractedText).toContain('When a project changes, a deliberate response is more useful than a rushed one.');
    expect(material.extractedText).toContain('A resilient team learns from the setback, adjusts its plan, and keeps moving.');
    expect(material.extractedText).not.toContain('#');
    expect(material.extractedText).not.toContain('**');
    expect(material.extractedText).not.toContain('[deliberate]');

    expect(analysis.id).toBe('analysis-1');
    expect(analysis.materialId).toBe('material-1');
    expect(analysis.status).toBe('analyzed');
    expect(analysis.analyzerVersion).toBe(analyzerVersion);
    expect(analysis.errors).toEqual([]);
    const ids = analysisItemIds(analysis);
    // 词义库未收录的词（ubiquitous/deliberate/resilient 等）不生成知识点。
    expect(ids).toContain('word:contemporary:wn31:a:02951280');
    expect(ids).not.toContain('word:contemporary:placeholder:1');
    expect(ids).not.toContain('word:ubiquitous:placeholder:1');
    expect(ids).not.toContain('word:deliberate:placeholder:1');
    expect(ids).not.toContain('word:resilient:placeholder:1');
    // 知识点保留原始出现记录：原始词形、所在原句与相邻句语境。
    const contemporary = analysis.items.find((item) => item.knowledgePoint.id === 'word:contemporary:wn31:a:02951280');
    expect(contemporary?.occurrences).toEqual([{
      rawForm: 'Contemporary',
      sentence: 'Contemporary teams work in a world where digital tools are ubiquitous.',
      context: ['When a project changes, a deliberate response is more useful than a rushed one.'],
    }]);

    // 材料与分析在同一次写入中保存，且重新加载后状态约束成立。
    expect(repository.saves).toHaveLength(1);
    expect(repository.saves[0]).toEqual({ material, analysis });
    expect(validateLearningState(state)).toEqual([]);
  });

  test('txt 原始文件：解码 UTF-8 并去掉 BOM 与 CRLF', async () => {
    const { repository } = setup();
    const rawFile = Buffer.from(plainSource, 'utf8');

    const result = await importMaterialUseCase(
      { repository, logger: silentLogger },
      baseInput({ filename: 'how-teams-adapt.txt', format: 'txt', rawFile }),
    );

    const { material } = expectOk(result);
    expect(material.format).toBe('txt');
    expect(material.mimeType).toBe('text/plain');
    expect(material.extractionMetadata).toEqual(
      expect.objectContaining({ extractor: 'plain-text', byteLength: rawFile.byteLength }),
    );
    expect(material.extractedText).toBe([
      'Contemporary teams work in a world where digital tools are ubiquitous.',
      '',
      'When a project changes, a deliberate response is more useful than a rushed one.',
      'A resilient team learns from the setback, adjusts its plan, and keeps moving.',
    ].join('\n'));
    expect(repository.saves).toHaveLength(1);
  });

  test('pdf 原始文件：提取文本层，元数据记录页数与空文本页', async () => {
    const { repository } = setup();
    const rawFile = await createPdfBuffer([
      'Contemporary teams work in a world where digital tools are ubiquitous.',
      'A resilient team learns from the setback, adjusts its plan, and keeps moving.',
    ]);

    const result = await importMaterialUseCase(
      { repository, logger: silentLogger },
      baseInput({ filename: 'how-teams-adapt.pdf', format: 'pdf', rawFile }),
    );

    const { material, analysis } = expectOk(result);
    expect(material.format).toBe('pdf');
    expect(material.mimeType).toBe('application/pdf');
    expect(material.extractionMetadata).toEqual(
      expect.objectContaining({ extractor: 'pdfjs-dist', pageCount: 1, pagesWithoutText: [] }),
    );
    expect(material.extractedText).toContain('ubiquitous');
    expect(material.extractedText).toContain('resilient');
    expect(analysis.status).toBe('analyzed');
    // 未配置词义库：全部词条库外，不生成知识点。
    expect(analysis.items).toEqual([]);
    expect(repository.saves).toHaveLength(1);
  });

  test('已提取文本路径：直接使用调用方文本，不再读取原始文件', async () => {
    const { repository } = setup();
    const extractedText = 'A resilient team learns from the setback, adjusts its plan, and keeps moving.';

    const result = await importMaterialUseCase(
      { repository, logger: silentLogger },
      baseInput({ extractedText, checksum: 'checksum-provided' }),
    );

    const { material, analysis } = expectOk(result);
    expect(material.extractedText).toBe(extractedText);
    expect(material.extractionMetadata).toEqual({ extractor: 'provided' });
    expect(material.checksum).toBe('checksum-provided');
    expect(analysis.materialId).toBe(material.id);
    expect(repository.saves).toHaveLength(1);
  });

  test('未提供 checksum 时按内容计算 SHA-256，同一内容结果稳定', async () => {
    const first = await importMaterialUseCase(
      { repository: new InMemoryMaterialRepository(createState()), logger: silentLogger },
      baseInput({ rawFile: Buffer.from(plainSource, 'utf8'), filename: 'notes.txt', format: 'txt' }),
    );
    const second = await importMaterialUseCase(
      { repository: new InMemoryMaterialRepository(createState()), logger: silentLogger },
      baseInput({ rawFile: Buffer.from(plainSource, 'utf8'), filename: 'notes.txt', format: 'txt' }),
    );
    const third = await importMaterialUseCase(
      { repository: new InMemoryMaterialRepository(createState()), logger: silentLogger },
      baseInput({ extractedText: plainSource.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'), filename: 'notes.txt' }),
    );

    const firstMaterial = expectOk(first).material;
    expect(expectOk(second).material.checksum).toBe(firstMaterial.checksum);
    expect(expectOk(third).material.checksum).not.toBe(firstMaterial.checksum);
    expect(firstMaterial.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  test('format 可由扩展名推断，显式 format 优先', async () => {
    const { repository } = setup();
    const result = await importMaterialUseCase(
      { repository, logger: silentLogger },
      baseInput({ filename: '材料.markdown', rawFile: Buffer.from(markdownSource, 'utf8') }),
    );
    expect(expectOk(result).material.format).toBe('markdown');

    const overridden = await importMaterialUseCase(
      { repository, logger: silentLogger },
      baseInput({ filename: 'notes.txt', format: 'markdown', rawFile: Buffer.from(markdownSource, 'utf8') }),
    );
    expect(expectOk(overridden).material.format).toBe('markdown');
  });

  test.each([
    { name: '无法推断格式', input: baseInput({ filename: 'notes.docx', rawFile: Buffer.from('x') }), reason: 'unsupported_format' },
    {
      name: 'pdf 原始文件无法解析',
      input: baseInput({ filename: 'broken.pdf', format: 'pdf', rawFile: Buffer.from('not a real pdf') }),
      reason: 'extraction_failed',
    },
    {
      name: '提取结果没有可分析文本',
      input: baseInput({ filename: 'empty.txt', format: 'txt', rawFile: Buffer.from('  \n\t ') }),
      reason: 'extraction_failed',
    },
    {
      name: '领域构造校验失败',
      input: baseInput({ learnerId: '', rawFile: Buffer.from(markdownSource, 'utf8') }),
      reason: 'invalid_input',
    },
    {
      name: '分析器参数缺失',
      input: baseInput({ analyzerVersion: '', rawFile: Buffer.from(markdownSource, 'utf8') }),
      reason: 'analysis_failed',
    },
  ])('失败路径（$name）：返回 $reason，不保存任何状态', async ({ input, reason }) => {
    const { state, repository } = setup();

    const result = await importMaterialUseCase({ repository, logger: silentLogger }, input);

    expect(result).toEqual({ ok: false, reason });
    expect(repository.saves).toHaveLength(0);
    expect(state.materials).toHaveLength(0);
    expect(state.materialAnalyses).toHaveLength(0);
  });
});

describe('S04 词义消歧（词义库 + AI Provider）', () => {
  const deliberateSenses: InventorySense[] = [
    { id: 'wn31:a:01340892', pos: 'adjective', gloss: 'carefully thought out in advance' },
    { id: 'wn31:v:00814706', pos: 'verb', gloss: 'think about carefully; weigh' },
  ];
  const contemporarySense: InventorySense = {
    id: 'wn31:a:02951280',
    pos: 'adjective',
    gloss: 'characteristic of the present',
  };

  function fakeInventory(entries: Record<string, InventorySense[]>): SenseInventory {
    return { lookup: (lemma) => entries[lemma] ?? [] };
  }

  test('单义词条直接选定词义项，不调用 AI', async () => {
    const { repository } = setup();
    const disambiguator: SenseDisambiguator = {
      disambiguate: async () => { throw new Error('must not be called'); },
    };

    const result = await importMaterialUseCase(
      {
        repository,
        senseInventory: fakeInventory({ contemporary: [contemporarySense] }),
        senseDisambiguator: disambiguator,
        logger: silentLogger,
      },
      baseInput({ extractedText: 'Contemporary teams use digital tools.' }),
    );

    const { analysis } = expectOk(result);
    const item = analysis.items.find(
      (entry) => entry.knowledgePoint.kind === 'word' && entry.knowledgePoint.lemma === 'contemporary',
    );
    expect(item?.knowledgePoint.id).toBe(`word:contemporary:${contemporarySense.id}`);
    expect(item?.knowledgePoint.sense).toEqual({
      id: contemporarySense.id,
      definition: contemporarySense.gloss,
      partOfSpeech: 'adjective',
      explanation: null,
    });
  });

  test('多义词条按出现记录消歧，一词一义：平票取最早出现支持的义项', async () => {
    const { repository } = setup();
    const requests: SenseDisambiguationItem[][] = [];
    const disambiguator: SenseDisambiguator = {
      async disambiguate(items) {
        requests.push(items);
        return items.map((item) => ({
          key: item.key,
          senseId: item.sentence.includes('deliberated') ? 'wn31:v:00814706' : 'wn31:a:01340892',
        }));
      },
    };

    const result = await importMaterialUseCase(
      {
        repository,
        senseInventory: fakeInventory({ deliberate: deliberateSenses }),
        senseDisambiguator: disambiguator,
        logger: silentLogger,
      },
      baseInput({
        extractedText: 'A deliberate response helped the team. The team deliberated the proposal overnight.',
      }),
    );

    const { analysis } = expectOk(result);
    // 两处出现各投一个义项（平票），最早出现支持形容词义胜出，全部出现归入该义项。
    const adjectiveItem = analysis.items.find(
      (entry) => entry.knowledgePoint.id === 'word:deliberate:wn31:a:01340892',
    );
    const verbItem = analysis.items.find(
      (entry) => entry.knowledgePoint.id === 'word:deliberate:wn31:v:00814706',
    );
    expect(adjectiveItem?.occurrences.map((occurrence) => occurrence.rawForm)).toEqual(['deliberate', 'deliberated']);
    expect(verbItem).toBeUndefined();
    // AI 一次收到两处出现（≤3 采样上限内全采），带上全部候选义项与原句语境。
    expect(requests).toHaveLength(1);
    expect(requests[0]).toHaveLength(2);
    expect(requests[0][0].candidates).toEqual(deliberateSenses);
    expect(requests[0][0].sentence).toBe('A deliberate response helped the team.');
    expect(requests[0][0].context).toEqual(['The team deliberated the proposal overnight.']);
  });

  test('词义库未收录的 lemma 不生成知识点', async () => {
    const { repository } = setup();

    const result = await importMaterialUseCase(
      { repository, senseInventory: fakeInventory({ contemporary: [contemporarySense] }), logger: silentLogger },
      baseInput({ extractedText: 'Ubiquitous tools are everywhere.' }),
    );

    const { analysis } = expectOk(result);
    expect(analysis.items.find(
      (entry) => entry.knowledgePoint.kind === 'word' && entry.knowledgePoint.lemma === 'ubiquitous',
    )).toBeUndefined();
    expect(analysisItemIds(analysis)).not.toContain('word:ubiquitous:placeholder:1');
    // 未收录的词仍然可见：记入 unmatchedItems，带原因与出现记录
    const unmatched = analysis.unmatchedItems.find((entry) => entry.lemma === 'ubiquitous');
    expect(unmatched?.reason).toBe('out-of-inventory');
    expect(unmatched?.occurrences.map((occurrence) => occurrence.rawForm)).toEqual(['Ubiquitous']);
  });

  test('被词表过滤的词记入 unmatchedItems（词元 + 过滤原因），不生成知识点', async () => {
    const { repository } = setup();

    const result = await importMaterialUseCase(
      {
        repository,
        senseInventory: fakeInventory({ contemporary: [contemporarySense] }),
        vocabularyFilter: (lemma) => (lemma === 'contemporary' ? { keep: false, reason: 'known' } : true),
        logger: silentLogger,
      },
      baseInput({ extractedText: 'Contemporary.' }),
    );

    const { analysis } = expectOk(result);
    expect(analysis.items).toEqual([]);
    expect(analysis.unmatchedItems).toEqual([
      {
        lemma: 'contemporary',
        reason: 'known',
        occurrences: expect.any(Array),
      },
    ]);
    expect(analysis.unmatchedItems[0].occurrences.map((occurrence) => occurrence.rawForm)).toEqual(['Contemporary']);
  });

  test('AI 返回候选集外的 senseId 时该词整体回退占位义项', async () => {
    const { repository } = setup();
    const disambiguator: SenseDisambiguator = {
      async disambiguate(items) {
        return items.map((item) => ({ key: item.key, senseId: 'wn31:x:99999999' }));
      },
    };

    const result = await importMaterialUseCase(
      {
        repository,
        senseInventory: fakeInventory({ deliberate: deliberateSenses }),
        senseDisambiguator: disambiguator,
        logger: silentLogger,
      },
      baseInput({ extractedText: 'A deliberate response helped the team.' }),
    );

    const { analysis } = expectOk(result);
    expect(analysisItemIds(analysis)).toContain('word:deliberate:placeholder:1');
    expect(analysisItemIds(analysis)).not.toContain('word:deliberate:wn31:a:01340892');
  });

  test('AI 请求失败时全部回退占位义项，分析仍成功保存', async () => {
    const { repository } = setup();
    const disambiguator: SenseDisambiguator = {
      async disambiguate() { throw new Error('LLM unreachable'); },
    };

    const result = await importMaterialUseCase(
      {
        repository,
        senseInventory: fakeInventory({ deliberate: deliberateSenses }),
        senseDisambiguator: disambiguator,
        logger: silentLogger,
      },
      baseInput({ extractedText: 'A deliberate response helped the team.' }),
    );

    const { analysis } = expectOk(result);
    expect(analysis.status).toBe('analyzed');
    const item = analysis.items.find(
      (entry) => entry.knowledgePoint.kind === 'word' && entry.knowledgePoint.lemma === 'deliberate',
    );
    expect(item?.knowledgePoint.id).toBe('word:deliberate:placeholder:1');
    expect(item?.occurrences).toHaveLength(1);
    expect(repository.saves).toHaveLength(1);
  });

  test('只提供词义库而未提供消歧器时，多义词条回退占位义项', async () => {
    const { repository } = setup();

    const result = await importMaterialUseCase(
      { repository, senseInventory: fakeInventory({ deliberate: deliberateSenses }), logger: silentLogger },
      baseInput({ extractedText: 'A deliberate response helped the team.' }),
    );

    const { analysis } = expectOk(result);
    expect(analysisItemIds(analysis)).toContain('word:deliberate:placeholder:1');
  });

  test('多义词条按预算分批请求 AI，失败批次只回退该批次词条', async () => {
    const { repository } = setup();
    const two = (lemma: string): InventorySense[] => [
      { id: `${lemma}-1`, pos: 'noun', gloss: `${lemma} first sense` },
      { id: `${lemma}-2`, pos: 'noun', gloss: `${lemma} second sense` },
    ];
    const calls: SenseDisambiguationItem[][] = [];
    const disambiguator: SenseDisambiguator = {
      async disambiguate(chunk) {
        calls.push(chunk);
        if (chunk.some((item) => item.lemma === 'beta')) throw new Error('chunk failed');
        return chunk.map((item) => ({ key: item.key, senseId: item.candidates[0].id }));
      },
    };

    const result = await importMaterialUseCase(
      {
        repository,
        senseInventory: fakeInventory({ alpha: two('alpha'), beta: two('beta'), gamma: two('gamma') }),
        senseDisambiguator: disambiguator,
        logger: silentLogger,
        chunkItemLimit: 1,
      },
      baseInput({ extractedText: 'Alpha matters. Beta matters. Gamma matters.' }),
    );

    const { analysis } = expectOk(result);
    // item 上限为 1：每个多义 lemma 独立成块，共三批。
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.length === 1)).toBe(true);
    const ids = analysisItemIds(analysis);
    // alpha 与 gamma 正常判定，beta 所在批次失败仅回退 beta。
    expect(ids).toContain('word:alpha:alpha-1');
    expect(ids).toContain('word:gamma:gamma-1');
    expect(ids).toContain('word:beta:placeholder:1');
    expect(ids).not.toContain('word:beta:beta-1');
  });
});

describe('词义库文件（data/sense-inventory-v1.json）', () => {
  test('真实词义库可加载，deliberate 含 3 个形容词义和 2 个动词义', () => {
    const inventory = loadSenseInventoryFromFile('data/sense-inventory-v1.json');
    const deliberate = inventory.lookup('deliberate');
    expect(deliberate).toHaveLength(5);
    expect(deliberate.filter((sense) => sense.pos === 'adjective')).toHaveLength(3);
    expect(deliberate.filter((sense) => sense.pos === 'verb')).toHaveLength(2);
    expect(deliberate.map((sense) => sense.id)).toContain('wn31:a:01340892');
    expect(inventory.lookup('a-lemma-that-does-not-exist')).toEqual([]);
  });
});

describe('markdown 文本提取', () => {
  test('剥离常见排版语法并保留自然语言', () => {
    const source = [
      '# 标题 Heading',
      '',
      'Some **bold** and _emphasis_ and `code` text.',
      '',
      '- first item',
      '- second item',
      '',
      '1. ordered item',
      '',
      '> quoted words',
      '',
      '| Name | Usage |',
      '| --- | --- |',
      '| ubiquitous | present everywhere |',
      '',
      'See [the link](https://example.com) and ![an image](https://example.com/a.png).',
      '',
      '---',
      '',
      '```ts',
      'const skipped = true;',
      '```',
      '',
      'Trailing ~~strike~~ text.',
    ].join('\n');

    expect(markdownToPlainText(source)).toBe([
      '标题 Heading',
      'Some bold and emphasis and code text.',
      'first item',
      'second item',
      'ordered item',
      'quoted words',
      'Name Usage',
      'ubiquitous present everywhere',
      'See the link and an image.',
      'Trailing strike text.',
    ].join('\n'));
  });
});
