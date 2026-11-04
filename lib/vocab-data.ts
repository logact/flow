// 词汇量测量的分层抽样词表：10 个频率段（1k~10k），每段 6 个候选，实测每段抽 4 个。
// 分段是近似值，原型阶段够用；正式版应替换为 COCA/BNC 词频表抽样。
export const BANDS: { band: number; words: string[] }[] = [
  { band: 1000, words: ['happy', 'water', 'family', 'money', 'night', 'friend'] },
  { band: 2000, words: ['journey', 'honest', 'kitchen', 'usual', 'weight', 'soldier'] },
  { band: 3000, words: ['achieve', 'bother', 'compete', 'distant', 'elderly', 'factor'] },
  { band: 4000, words: ['abandon', 'cautious', 'delicate', 'emerge', 'fragile', 'genuine'] },
  { band: 5000, words: ['ambiguous', 'bulk', 'commence', 'discrete', 'evoke', 'feasible'] },
  { band: 6000, words: ['articulate', 'bleak', 'credible', 'deflate', 'eccentric', 'facade'] },
  { band: 7000, words: ['adversity', 'boisterous', 'candor', 'dogged', 'elated', 'fickle'] },
  { band: 8000, words: ['abate', 'cajole', 'deference', 'efface', 'gamut', 'hackneyed'] },
  { band: 9000, words: ['acerbic', 'bilk', 'chary', 'demur', 'eschew', 'feckless'] },
  { band: 10000, words: ['abstemious', 'captious', 'descant', 'etiolated', 'froward', 'gambol'] },
];

// 伪词：用户声称"认识"则视为虚报，按比例扣减估计值
export const NONWORDS = ['flendor', 'prisket', 'twanious', 'glommer'];

// IELTS 学术核心词（原型 40 词小样，正式版替换为完整 AWL/IELTS 词表）
export const IELTS_WORDS: { word: string; gloss: string; sentence: string }[] = [
  { word: 'acquire', gloss: '获得，习得', sentence: 'She acquired the skill through daily practice.' },
  { word: 'adapt', gloss: '适应，调整', sentence: 'He adapted quickly to the new environment.' },
  { word: 'adequate', gloss: '足够的，合格的', sentence: 'His explanation was barely adequate.' },
  { word: 'allocate', gloss: '分配，拨给', sentence: 'The city allocates funds to public schools.' },
  { word: 'analyze', gloss: '分析', sentence: 'Scientists analyze the data carefully.' },
  { word: 'anticipate', gloss: '预期，预料', sentence: 'We anticipate a rise in demand.' },
  { word: 'apparent', gloss: '明显的', sentence: 'Her relief was apparent to everyone.' },
  { word: 'approach', gloss: '处理，接近', sentence: 'They approached the problem differently.' },
  { word: 'appropriate', gloss: '合适的', sentence: 'Wear appropriate clothes for the interview.' },
  { word: 'approximate', gloss: '大约的', sentence: 'The approximate cost is two hundred dollars.' },
  { word: 'aspect', gloss: '方面', sentence: 'Consider every aspect of the plan.' },
  { word: 'assemble', gloss: '集合，组装', sentence: 'Students assembled in the hall.' },
  { word: 'assess', gloss: '评估', sentence: "Teachers assess students' progress monthly." },
  { word: 'assign', gloss: '指派，分配', sentence: 'He was assigned to the night shift.' },
  { word: 'assume', gloss: '假定，认为', sentence: "Don't assume the worst." },
  { word: 'attain', gloss: '达到，获得', sentence: 'She attained her goal after years of work.' },
  { word: 'attribute', gloss: '归因于', sentence: 'He attributes his success to luck.' },
  { word: 'authority', gloss: '当局，权威', sentence: 'Local authorities closed the road.' },
  { word: 'benefit', gloss: '有益于', sentence: 'Exercise benefits both body and mind.' },
  { word: 'bias', gloss: '偏见', sentence: 'The report showed a clear bias.' },
  { word: 'bond', gloss: '纽带，联系', sentence: 'Travel created a strong bond between them.' },
  { word: 'capable', gloss: '有能力的', sentence: 'She is capable of much more.' },
  { word: 'capacity', gloss: '容量，能力', sentence: 'The hall has a capacity of five hundred.' },
  { word: 'category', gloss: '类别', sentence: 'These books fall into three categories.' },
  { word: 'cease', gloss: '停止', sentence: 'The rain ceased at dawn.' },
  { word: 'challenge', gloss: '质疑，挑战', sentence: 'He challenged the decision in court.' },
  { word: 'channel', gloss: '引导，输送', sentence: 'They channeled their energy into work.' },
  { word: 'cite', gloss: '引用', sentence: 'She cited three studies in her essay.' },
  { word: 'civil', gloss: '文明的，客气的', sentence: 'They had a civil discussion.' },
  { word: 'clarify', gloss: '澄清', sentence: 'Could you clarify your point?' },
  { word: 'coherent', gloss: '连贯的', sentence: 'His argument was clear and coherent.' },
  { word: 'coincide', gloss: '同时发生', sentence: 'The events coincided with the festival.' },
  { word: 'collapse', gloss: '倒塌，崩溃', sentence: 'The bridge collapsed in the storm.' },
  { word: 'colleague', gloss: '同事', sentence: 'She discussed it with a colleague.' },
  { word: 'commit', gloss: '投入，承诺', sentence: 'He committed himself to the project.' },
  { word: 'compensate', gloss: '赔偿，补偿', sentence: 'The company compensated the workers.' },
  { word: 'compile', gloss: '编纂，汇编', sentence: 'They compiled a list of sources.' },
  { word: 'complement', gloss: '补充，相配', sentence: 'The wine complements the meal.' },
  { word: 'complex', gloss: '复杂的', sentence: 'The issue is more complex than it seems.' },
  { word: 'comprise', gloss: '由……组成', sentence: 'The committee comprises ten members.' },
  { word: 'concentrate', gloss: '专注，集中', sentence: 'She concentrated on her research.' },
];

// 书本提取用的停用词（高频虚词 + 最常见实词，避免把 the/people/time 当成目标词）
export const STOPWORDS = new Set(
  `a an the and or but if then else when while at by for with without about into through during
   before after above below between to from up down in out on off over under again further once
   here there all any both each few more most other some such no nor not only own same so than
   too very can could will would shall should may might must i you he she it we they me him her
   us them my your his its our their mine yours ours theirs this that these those am is are was
   were be been being have has had having do does did doing don doesn didn what which who whom
   whose how why where when as of just also even still well back much many really always never
   often sometimes usually already yet however though therefore because until unless since
   people time year way day man thing woman life child world hand part place case week point home
   make get go know take see come think look want give use find tell ask seem feel try leave call
   said say says went gone got make made took come came think thought see saw know knew
   one two three first second new old good bad big small long right left high low little great
   something anything everything nothing someone anyone everyone no one every`
    .split(/\s+/)
    .filter(Boolean)
);

// 书目标的示例文本（深度工作主题，含可重复提取的内容词）
export const SAMPLE_TEXT = `Deep work is the ability to focus without distraction on a demanding task. Most people believe they focus well, but constant distraction has weakened their attention. Every notification pulls attention away from the task, and each switch makes the brain slower. To rebuild attention, schedule a daily deep work session and protect it. During a session, the phone stays outside the room. One task, one hour, zero distraction. At first the brain resists. Boredom appears within minutes, and the urge to check the phone feels physical. That discomfort is the training. A short session every morning builds the focus muscle faster than a long session once a week. Over a month, the brain adapts: distraction loses its grip, and deep focus becomes the default. The quality of work rises, tasks finish faster, and attention turns into a genuine advantage.`;
