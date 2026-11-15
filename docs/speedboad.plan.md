# speedboat plan v2
This plan is target to develop fast and verify fast, and avoid the Cumbersome automation process and overdesign,In this prototype we need agile turn and we need keep our boat light,remove  all extral thinig but the core proces.

for more detail you can read the @RPD

# overview
core logic
1. learner estimate the level ,the system generate the test tasks ,and init the level by the user's result of the tasks.
2. learner setup some basic information
   1. his/her task capacity every day.
3. learner set the goal to achieve ,and set the materials into the goal,system analyze the materials and sepearete into to the knowledge points,and init their fluency score in differnet dimmension according to the user's level and the leanrt words conditions
   1. the goal set the target  fluency score in different dimmension of all the kp in the goals' material
   2. the kp here indentify by word/phase/grammar/other.. + sense
   3. user select the kp to learn and select the kp not to learn.
4. system generate the learner tasks according to the specific goals and user's learner's everyday capacity.
5. user answer the task assign by system ,and system jude the res and modify the fluency of the knowledge point in different dimension and modify the study plan (the cold interval between the simailar word and the review time ),and update the user's level


# scenarios

本文的“场景”指**应用层用例**：应用层加载和保存状态、分配 ID、获取时间、调用外部服务，并按顺序调用领域接口。词汇估计、下一任务决策、评判规则、流利度和复习间隔算法仍属于领域层，不在用例中重新实现。

## 一、应用层统一约定

- 存储使用 Repository 接口；测试模拟使用内存数据库，实际运行切换为 SQLite。用例不直接依赖具体数据库。
- Prototype 可以将 `LearningState` 作为完整状态快照读写，但每个用例只保存本次变更，写入后必须能通过 Repository 重新加载。
- 数据库事务只包围状态写入，不包围文件解析或 AI 请求，避免长时间占用事务。
- 应用层负责生成测评、任务、作答等 ID，并注入当前时间；领域函数不自行读取时钟或数据库。
- 跨多个领域函数的写用例要么保存完整结果，要么不保存，不能只保存中间状态。
- 面向客户端返回任务时使用公开视图，不能直接序列化包含答案、证据或评分标准的服务端任务。

## 二、按环节拆分的小场景（应用用例）

### S01：创建学习者或更新学习设置

**输入**

- 创建：`id`、`timezone`、`dailyTaskCapacity`、`now`。
- 更新：`learnerId`、可选的新容量或时区、`now`。

**应用层编排**

1. 创建时检查学习者不存在；更新时通过 Repository 加载学习者。
2. 调用 `createLearner` 或 `updateLearnerSettings`。
3. 保存学习者。

**输出与边界**

- 返回保存后的 `Learner`；新学习者的 `currentVocabulary = null`。
- 更新容量不直接重写历史计划；下一次执行 S07～S09 时才应用新容量并处理任务取消。

### AI Provider 统一配置

后续 S04、S08、S11 使用的 AI Provider 需要支持 OpenAI、DeepSeek、Kimi；API key、baseURL、model 通过环境变量读取，默认使用 DeepSeek。AI Provider 由应用层/基础设施层实现，API 密钥、超时和重试不进入 Domain。

```bash
export LLM_API_KEY=
export LLM_BASE_URL=https://api.deepseek.com
export LLM_MODEL=deepseek-chat
```

### S02：开始词汇自评定级

**输入**

`learnerId`、词表引用 `list`、各词段抽样数 `sampleCounts`、随机种子 `seed`、`assessmentId`、与样本等长的 `taskIds`、`now`。

**应用层编排**

1. 加载学习者，通过词表 Repository 读取指定版本的词族。
2. 调用 `sampleVocabularyForAssessment` 得到样本。
3. 调用 `generateVocabularyAssessmentTasks` 为样本创建词汇自评任务；任务只包含被测词汇，不生成语境、释义选项或正确答案，也不调用 AI。
4. 调用 `createVocabularyAssessment` 创建进行中的测评。
5. 在同一写入中保存测评及全部自评任务。

**输出与边界**

- 返回 `assessmentId` 和按顺序执行 `toLearnerVocabularyAssessmentTask` 得到的公开任务；每项只呈现 `lemma` 等自评所需信息。
- 公开响应不包含服务端词义、选项或正确答案；界面提供“认识 / 不认识”两种自评操作。

### S03：提交词汇自评并完成测评

**输入**

`assessmentId`、`taskId`、`attemptId`、`known: boolean`、`answeredAt`，以及完成测评所需的 `list` 和各词段词族总数。

**应用层编排**

1. 加载学习者、测评、当前自评任务和已有自评记录。
2. 若 `attemptId` 已存在，返回已有结果，不重复追加。
3. 调用 `recordVocabularyAssessmentAttempt` 原样记录学习者的 `known` 自评，不进行客观对错判定。
4. 保存本次自评；若仍有未自评词汇，测评保持 `in_progress` 并结束本次用例。
5. 若全部词汇已自评，调用 `completeVocabularyAssessment`，按各词段 `knownCount / sampleCount` 估计掌握概率并计算 Wilson 区间。
6. 在同一写入中保存最后一条自评、已完成测评和更新后的学习者。

**输出与边界**

- 未完成时返回测评进度；完成时返回 `VocabularyEstimate`，各词段证据使用 `knownCount`，不再使用 `correctCount`。
- 测评未完成时不能向 S06 提供伪造的词汇估计。

### S04：导入并分析材料

**输入**

`materialId`、`analysisId`、`learnerId`、文件元数据、原始文件或已提取文本、`analyzerVersion`、`now`。

**应用层编排**

1. 若收到原始文件，由应用层完成格式解析和文本提取。
2. 调用 `createMaterial` 创建材料。
3. 调用 `extractMaterialTerms` 本地提取术语（分句、分词、词形归并），按词义库确定义项：单义词条直接选定，多义词条由应用层 AI Provider 逐出现消歧（按 item 数与 prompt 字符预算分批请求，失败批次仅回退该批次词条），库外或消歧失败回退占位义项。
4. 调用 `analyzeMaterial` 传入义项归属组装分析，知识点 ID 为 `word:{lemma}:{senseId}`。
5. 保存材料及固定版本的分析结果。

**输出与边界**

- 返回 `Material` 和 `MaterialAnalysis`，包括知识点原始出现记录及未匹配项。
- 文本提取或分析失败时，不把该材料作为已分析材料交给 S05。

### S05：创建目标并加入已分析材料

**输入**

创建目标时输入 `learnerId`、目标标题、`targetFluency`、`materialId`、`analysisId`、`addedAt` 和 `now`；加入已有目标时额外输入已有 `goalId`。新目标 ID 由服务端生成并在成功响应中返回，不由客户端生成或从草稿恢复。

**应用层编排**

1. 加载学习者、材料、`analyzed` 分析、已有候选和来源。
2. 创建目标时调用 `createLearningGoal`；已有目标则从 Repository 加载。
3. 调用 `addAnalyzedMaterialToGoal`，传入已有候选和来源。
4. 保存目标、材料关联、规范化知识点、合并后的候选和来源。

**输出与边界**

- 返回目标及其学习范围。
- `GoalMaterial` 固定本次 `analysisId`；增量合并不能重置已有选择状态。
- 本用例只确定候选范围，不初始化流利度。

### S06：设置知识点选择并初始化新增学习项

**输入**

`goalId`、一组 `knowledgePointId + selection`、`policyVersion`、`now`。

**应用层编排**

1. 加载学习者、目标候选、知识点、词频分类及已有 `LearnerKnowledgePoint`。
2. 对每个候选调用 `setGoalKnowledgePointSelection`。
3. 对新变为 `included` 且尚无学习状态的知识点，要求学习者已有 `currentVocabulary`。
4. 尚无词频分类记录的词汇知识点，通过词表端口查询所属词族频段并新建 `knowledgePointVocabularyClassifications` 记录（分类依据学习者当前词汇估计的词表及版本）；词表未收录的词与非词汇类知识点不建记录，初始流利度按 0 处理。
5. 调用 `deriveInitialFluency`（传入新建或已有的分类记录），再将返回的 `derived` 原样传给 `initializeLearnerKnowledgePoint`。
6. 保存选择变化、新增学习状态及新词频分类记录。

**输出与边界**

- 返回更新后的候选和新增学习状态。
- `excluded` 不删除历史学习状态或任务；需要取消的任务由后续 S07 决定。
- 已有学习状态不重复初始化；已有词频分类记录不重复写入；未完成定级时返回前置条件错误，本批变更不部分写入。

### S07：生成每日排期决策

**输入**

`learnerId`、本地日期 `date`、`now`。

**应用层编排**

1. 通过 Repository 加载完整 `LearningState`。
2. 调用 `planDailyStudy` 得到 `DailyStudyDecision`。
3. 将决策交给 S08 生成所有 `new` 位置的任务；本用例不生成题目，也不修改状态。

**排期约束**

- 新词准入：首次引入知识点前，按当前全成功学习与复习路径预测今天起 42 天的任务需求；既有任务优先且不顺延。任何未来日期超过每日容量时，首个无法容纳的新词及后续新词当天均不引入。
- 到期复习也复用本用例：应用层只传入新的 `date` 和 `now`，不自行计算复习间隔。
- 未达标答对不进入间隔复习：当天到期并升级为下一级任务，排期优先级高于新词；答错同样当天到期重练。达标后才进入 1/3/7/30 天间隔复习（按连对 streak 推进），通过最后一次 30 天间隔复习标记 `graduated`。
- 达到目标分数不等于复习毕业：达标后的到期任务固定为 `FLUENCY`，只有该维度通过最后一次 30 天间隔复习并标记 `graduated` 后才停止派题。
- 容量缩减时，排期决策负责给出 `cancelTaskIds` 和 `expireTaskIds`，应用层不自行决定取消或过期任务。
- 规格漂移失效：保留今日计划中的既有任务前，按当前学习状态重算该知识点的下一任务规格；规格已变化（题型、维度或 `RETRIEVE` 档位不同）时，该任务进入 `cancelTaskIds`，同一位置改由 `new` 规格重新生成；当前没有到期规格时不视为漂移，任务保留。只有受结算影响的任务会被重生成，其余已生成任务原样保留，不整批重生成。
- 新词准入与排位分散分两步：先按 `goalId`、`wordId` 稳定顺序逐个执行 42 天容量预测，确定本次准入新词集合；首个预测超容量的新词及其后续新词均不准入。准入结果固定后，再参与下述排序，不因分散改变准入集合或数量。
- 候选任务按三个优先级段依次排期：①已达标且待复习；②未达标且 `dueAt` 的学习者本地日期早于当前学习日；③未达标且 `dueAt` 属于当前学习日，以及已准入新词。第一、二段按 `dueAt` 升序，时间相同再按 `goalId`、`wordId` 升序；第三段中今日到期任务与新词视为同一桶，不再按 `dueAt` 分桶。
- 第一、二段中相同优先级及相同 `dueAt` 的候选构成分散桶；第三段的今日到期任务与新词共同构成分散桶。桶按优先级段顺序处理；每次从当前桶选择词族（无词族信息时用词本身）最近一次出现位置距当前序列末尾最远的候选，追加至队尾并更新位置，再重复选择。新词若在历史前缀及已排任务中存在相同词族的前序任务，按该词族最近出现位置计算实际距离；若不存在，则新词的距离按默认值 `5` 参与同桶竞争，不按无限大处理。其他候选沿用原有距离规则。当日尚未出现的非新词候选词族仍视为距离最大；距离相同按 `goalId`、`wordId` 升序。桶内没有其他候选时照常排入，不等待。当天已完成任务按完成时刻构成历史前缀，已排任务也计入距离。分散不得改变桶之间的优先级。

**输出与边界**

- 返回 `DailyStudyDecision`，其中 `existing` 表示保留任务，`new` 只包含待生成的 `TaskSpecification`。
- 决策是暂态编排数据，尚未形成已保存的每日计划；状态发生变化时必须重新排期，不能沿用旧决策。

### S08：生成学习任务

**输入**

一个 `new` 位置对应的 `TaskSpecification`，以及应用层分配的 `taskId`、`learnerId`、`issuedAt`。

**应用层编排**

1. 根据 `specification.goalId` 和 `specification.wordId` 加载目标知识点及目标来源材料，同时加载学习者最新词汇水平估计（`currentVocabulary`）。
2. **应用层调用 AI Provider，根据 `TaskSpecification`、知识点、学习者词汇水平和 `sourceMaterials` 生成 `GeneratedTask`；提示词须要求 AI 按学习者实际水平控制题目难度。Domain 不直接调用 AI；当前 `generateLearningTask` 是本地模板生成路径，不代替本用例的 AI 生成路径。**
3. 应用层解析 AI 输出后调用 `validateGeneratedTask`，核对任务类型、知识点、R/P 维度和提取阶段。
4. 校验通过后调用 `createLearningTask`，生成服务端完整 `LearningTask`。
5. AI 生成使用 AI Provider 统一配置；外部调用期间不持有数据库事务。

**输出与边界**

- 返回 `LearningTask`，交给 S09 与其他新任务一起应用。
- 本用例不单独持久化 `issued` 任务，避免生成后未进入计划的孤立任务。
- AI 请求、输出解析或规格校验失败时返回失败，不创建、不保存、不下发任务；S09 不得应用残缺任务集合。
- 输出仍包含服务端答案或评分材料，只能在应用层内部传递，不能直接作为客户端响应。

### S09：应用排期决策并保存每日计划

**输入**

可选 `planId`、S07 返回的 `DailyStudyDecision`、S08 为全部 `new` 位置生成的 `LearningTask[]`、`now`。

**应用层编排**

1. 重新加载完整状态，确认没有使当前决策失效的并发变化；若已变化，则从 S07 重新执行。
2. 核对每个 `new` 位置都有且仅有一个符合规格的新任务。
3. 调用 `applyDailyStudyDecision`。
4. 在同一写入中保存新计划、新任务以及过期、取消任务的状态变化。
5. 按计划顺序执行 `toLearningTaskView`，返回公开任务列表。

**输出与边界**

- 返回已保存的 `DailyStudyPlan` 摘要和 `LearningTaskView[]`。
- 只有全部新任务就绪才应用决策；任一生成失败时不保存部分计划或部分任务。
- 任务公开响应不包含答案、阅读证据或场景表达评分标准。

### S10：接收学习任务作答

**输入**

`attemptId`、`taskId`、`submission`、`validity`、`receivedAt`。

**应用层编排**

1. 通过 Repository 加载完整状态。
2. 若 `attemptId` 已处理，返回已有作答，保证客户端重试幂等。
3. 调用 `recordTaskAttempt`，由领域层检查任务和提交有效性。
4. 保存返回的新状态。

**输出与边界**

- 返回 `received`、`invalid` 或 `unavailable` 作答状态。
- `received` 可以触发 S11；无效作答不进入评判和结算。
- 本用例只接收首次原始答案，不直接修改流利度或复习计划。

### S11：评判并结算学习任务作答

**输入**

`attemptId`、`judgedAt`、`now`。

**应用层编排**

1. 加载完整状态，根据 `attemptId` 找到原始作答及服务端完整任务。
2. 若已经 `settled`，返回已有结果；若处于 `received`，调用 `startTaskAttemptJudging` 并保存 `judging` 状态。
3. 选择题及其他答案完全确定的题目调用 Domain `judgeTask` 进行规则评判。
4. **需要语义判断的非选择题由应用层调用 AI Provider 评判，包括 `RETRIEVE` 的 `cued/free`、阅读 `free` 问题和 P 场景表达。应用层将原始 `submission`、题目、答案或评分要求交给 AI，并把结果构造为 `judgedBy = 'ai'` 的 `TaskJudgement`；Domain `judgeTask` 不负责发起 AI 请求。**
5. AI 评判使用 AI Provider 统一配置。应用层校验 `taskId`、评判维度、结果结构和 `judgedAt`，再调用 `settleTaskAttempt`。
6. 在同一写入中保存结算返回的完整状态。

**输出与边界**

- 返回评判反馈及本次 `TaskSettlement`。
- FLUENCY 的 `TaskJudgement` 必须包含 `targetPassed`、`overallPassed` 和 `speedWpm`；R 速度按原文词数与 `readingElapsedMs` 计算，P 速度按产出词数与作答总耗时计算。
- Domain 按任务阶段和上述证据直接计算绝对流利度：RETRIEVE 使用 20/40/60 及失败赋分表，FLUENCY 使用目标/整体通过规则与 R/P 速度公式，不再固定增减 2 分。
- AI 只负责给出评判结果；应用层不自行计算分数变化、复习间隔或词汇估计，统一由 Domain 结算。
- AI 请求、输出解析或结果校验失败时不调用结算；保留原始作答供重试，不用新答案覆盖它，也不将失败结果伪装成规则评判。
- 保存时检测学习状态并发冲突，避免覆盖其他作答已经产生的更新。

### S12：完成或归档学习目标

**输入**

`goalId`、目标状态 `completed | archived`、`now`。

**应用层编排**

1. 加载目标并调用 `changeLearningGoalStatus`。
2. 保存目标状态，保留材料、候选知识点、任务和学习历史。

**输出与边界**

- 返回更新后的目标。
- 后续 S07～S09 不为非 `active` 目标生成和保存新任务；本用例不直接删除或取消历史记录。

## 三、端到端大场景（应用用例编排）

大场景不是新的领域函数，也不是一个包办所有工作的巨型服务，而是按顺序调用 S01～S12，并在每次状态写入后从 Repository 重新加载状态，验证应用层产物能够衔接。

### 固定输入

- 学习者：小林，`timezone = Asia/Shanghai`，每日容量 5。
- 目标：`读懂并谈论团队如何应对变化`，`targetFluency = { R: 80, P: 80 }`。
- 材料：`how-teams-adapt.md`：

> Contemporary teams work in a world where digital tools are ubiquitous. When a project changes, a deliberate response is more useful than a rushed one. A resilient team learns from the setback, adjusts its plan, and keeps moving. Teams that adapt quickly treat every pivot as a chance to learn. Honest feedback protects morale and builds momentum, because people do their best work when they feel heard.

本场景将材料中的 `contemporary`、`ubiquitous`、`deliberate`、`resilient`、`adapt`、`setback`、`pivot`、`feedback`、`morale`、`momentum` 十个候选全部设为 `included`。`deliberate` 使用“深思熟虑的”这一独立词义。

**循环退出条件**：学习循环（步骤 12）一直推进，直到目标内全部十个知识点的 R、P 两个维度都**复习毕业**（`review.graduated`）。每个维度要先练到 `targetFluency`（≥80），之后达标复习固定派 `FLUENCY` 任务，间隔按 +1、+3、+7、+30 天推进，通过最后一次 30 天间隔复习后标记 `graduated` 才停止派题；场景必须完整模拟这条毕业复习链。

**结算即重排（R2 语义）**：学习日内每答完一题、结算完成后立即用最新状态重新排期，后续任务一律以最新计划为准——在途任务不是按天快照，而是随每次结算刷新。已引入词的另一维度到期、答错词间隔清零后的重试，都会在**同一天**内升级派题。每日容量约束的是"同时在途任务数"（每次排期不超过容量，答完一题空出一位即由排期决定补升级任务还是新词），与当天已完成数量无关；新词引入只看 42 天准入预测。当日计划在途任务与新生成都为空时学习日结束。

### 调用顺序与状态传递

| 步骤 | 应用用例 | 应用层动作 | 产物 |
| --- | --- | --- | --- |
| 1 | S01 | 创建小林，容量设为 5 | 持久化 `Learner` |
| 2 | S02 | 读取词表、抽样，创建不含选项和答案的词汇自评任务并保存测评 | 测评及服务端自评任务 |
| 3 | S03 | 提交全部 `known` 自评并完成测评 | 完成的测评、自评记录、`currentVocabulary = V0` |
| 4 | S04 | 提取材料文本并完成分析 | `Material`、`MaterialAnalysis` |
| 5 | S05 | 创建目标并加入固定分析版本 | 目标、材料关联、候选和来源 |
| 6 | S06 | 纳入十个候选并初始化 | 选择结果、十条学习状态 |
| 7 | S07 | 对 S06 后的真实状态排期：included 候选按到期与新词准入产出一批 `new` 规格，首批不超过每日容量 5 | 暂态 `DailyStudyDecision` |
| 8 | S08 × N | **由应用层调用 AI**，N 为决策中 `new` 位置数，按各规格生成任务 | N 项暂态服务端 `LearningTask` |
| 9 | S09 | 一次性应用决策及全部新任务 | 持久化计划、N 项 `issued` 任务 |
| 10 | S10 × N | 分别提交 N 项作答；`ubiquitous` 首次出现的 RETRIEVE 选择题有效但答错 | N 条首次作答 |
| 11 | S11 × N | ENCODE 与选择题规则评判；**RETRIEVE cued/free、阅读 free 问题、P 场景表达由应用层调用 AI 评判**；阅读混合题合并规则与 AI 结果后统一结算 | N 个 `settled` 作答、N 个完成任务、更新后的学习状态和 `V1` |
| 12 | 学习循环：每日重复 7～11 | 每个学习日把 `now` 推进到当前状态最早未来 `dueAt` 之后重新排期；日内每答一题结算后立即重排（R2 语义），后续任务以最新计划为准，已引入词的新维度/失败重试当天升级派题。**直到全部十个知识点的 R、P 维度都复习毕业**（含达标后的 +1/+3/+7/+30 天 FLUENCY 复习链）；答错的 `ubiquitous` 当天重练，验证失败路径与到期复习驱动 | 逐日计划与结算链、全部毕业的学习状态 |
| 13 | S12 → S07～S09 | 归档目标后再次请求计划 | 保留历史，不再生成该目标的新任务 |

第 7 步的决策由真实 `planDailyStudy` 对 S06 后的状态计算，不由场景预设：无学习状态的候选产出 `ENCODE`；已有初始学习状态的候选按初始流利度产出 RETRIEVE（<20 `choice`、<40 `cued`、<60 `free`）。FLUENCY 任务只在循环推进、某维度流利度练到 60 以上后出现。当前实现下词频分类记录尚无写入方，初始流利度一律为 0，首轮排期为 `ENCODE` 规格；十个新词受每日容量 5 限制，按 42 天准入预测分批引入，首日最多 5 个，其余词在后续有剩余容量时陆续首批。分类写入补齐后首轮可能直接出现 RETRIEVE 各档。两种情形本场景编排一致，测试只断言结构属性：`new` 数不超过每日容量、每词至多一个规格、首轮不含 FLUENCY（初始分上限 50，低于 FLUENCY 门槛 60）。S07 只产生这些规格，S08 才通过应用层 AI Provider 生成具体题目，S09 才将任务和计划一起持久化。

### 大场景验收

1. 同一套用例契约可以先在内存 Repository 上运行，再切换到 SQLite Repository 运行，不需要修改用例流程。
2. 每个写用例只使用前序用例持久化后的 ID 和状态，不依赖内存对象引用；每次写入后重新加载，`validateLearningState` 不返回约束错误。
3. S04、S08 的外部能力失败时，不出现部分写入的分析或每日计划；S02 不调用外部 AI，只保存完整的自评任务和测评。
4. S07 不创建任务或计划；S08 不持久化孤立任务；只有 S09 能将完整计划和任务集合一起写入。
5. S10 重试使用同一 `attemptId` 不会增加首次作答；S11 重试不会重复结算。
6. 每个学习日结算后当日任务均为 `completed`，答错项（`ubiquitous` 首次出现的 RETRIEVE 选择题）保留真实 `incorrect` 评判而非伪造结果；流利度、复习计划和词汇估计来自各自结算快照。
7. S09 的公开任务响应不包含答案、阅读证据或场景表达评分标准。
8. 到期复习由新的 S07～S09 调用产生；归档后历史仍可加载，但不再出现该目标的新任务。
9. 应用用例测试使用可控的 Fake AI Provider 返回固定题目和评判，验证编排、失败与幂等；真实供应商调用单独做 Live 验证。非选择题的 AI 评判必须以 `judgedBy = 'ai'` 进入同一 Domain 结算路径。
10. 循环在有限天数内退出，退出时目标内全部十个知识点的 R、P 维度均已 `graduated`（流利度 ≥ `targetFluency` 且走完 30 天间隔毕业复习），且每个知识点至少经历过一次结算；退出前 RETRIEVE `choice`/`cued`/`free` 与 `FLUENCY-R`、`FLUENCY-P` 均实际出现过。
11. 容量与准入生效：每次排期的任务数不超过每日容量（"同时在途任务数"语义）；新词引入由 42 天准入预测决定，答完一题空出的位置由下一次排期立即决定补升级任务还是新词。

## 四、组合编排用例

组合编排用例只做编排，不引入新的领域逻辑：按顺序调用已拆分的小用例，每次状态写入后从 Repository 重新加载。核心设计决策是**不引入跨用例事务**——结算与重排是两个独立、各自幂等的原子写顺序执行，原子边界仍各自落在 S11 的结算写入和 S09 的计划写入上。

### R1：刷新每日计划（S07～S09 编排）

**输入**

`learnerId`、`date`、`now`。

**应用层编排**

1. 通过 Repository 加载完整状态，调用 Domain `planDailyStudy` 得到暂态 `DailyStudyDecision`。
2. 为决策中全部 `new` 规格调用 S08 生成暂态服务端任务，分配任务 ID 并注入 `issuedAt`。
3. 任一生成失败时整体返回失败，本用例不落任何状态（完整继承 S08 语义）。
4. 全部生成成功后调用 S09 应用决策；保存时检测到并发冲突则从第 1 步重新执行，重试有上限，用尽后返回冲突失败。

**输出与边界**

- 成功时返回 S09 的结果：保存后的 `DailyStudyPlan` 及按决策顺序排列的公开任务视图。
- S07 不创建任务或计划；S08 不持久化孤立任务；只有 S09 将完整计划和任务集合一起写入。
- 决策的 `new` 为空时（容量为 0、无非 `active` 目标的新需求等）不调用 AI，直接走 S09 应用 `existing` 决策，使取消、过期等状态变化照常落库。
- 同一 `(learnerId, date)` 重复调用是安全的：每次都从最新状态重新决策，S09 用乐观锁保证不会用旧决策覆盖并发写入。

### R2：结算并刷新计划（settleAndRefreshPlan）

**输入**

`attemptId`、`judgedAt`、`now`。

**应用层编排**

1. 调用 S11 `judgeAndSettleTaskAttempt`；已 `settled` 的作答直接返回已有结算结果，天然幂等。
2. S11 成功后，同一请求内调用 R1 `refreshDailyPlan`，`learnerId` 取作答所属学习者，`date` 取 `now` 按学习者时区换算的当日日期。
3. R1 失败不回滚 S11 的结算；返回结构化双结果，由调用方决定是否在稍后单独重试 R1。

**输出与边界**

- 返回 `{ settlement, feedback, refresh }`，其中 `refresh` 为 `{ ok: true, plan, tasks } | { ok: false, reason }`；S11 本身失败时整体抛出，不进入 R1。
- S11 的结算先独立落库，R1 从 Repository 重新加载时读到的是已结算状态，重排自然反映本次结算产生的流利度、复习间隔和词汇估计变化。
- R1 中 S08 失败时"不落任何状态"的语义不变：组合用例的整体原子边界仍在 S09，不存在部分写入的计划或任务。
- R1 失败（AI 生成失败或并发冲突重试用尽）时的状态为"已结算但当日计划未刷新"，这是可收敛的暂态：之后任何一次 R1 调用都会从最新状态重新决策并收敛，不需要补偿或回滚。
- 结算与重排在请求内串行，单次请求时延为 S11 的 AI 评判与 S08 的 AI 生成之和；客户端若需要尽快返回作答反馈，可以不使用本用例，改为调用 S11 后在客户端另行触发 R1。
- 调用方耦合的退出成本很低：R1 是独立用例，`settleAndRefreshPlan` 只是 S11 + R1 的薄封装，拆回两次调用不需要重新设计。

## Prototype 边界

- 词频分类记录（`knowledgePointVocabularyClassifications`）曾长期没有任何环节写入，导致初始流利度恒按 0 派生、词汇估计不随作答更新、新词准入预测失真；现由 S06 在初始化时经词表端口写入，词表未收录的词不建记录。
- 实现顺序为：Repository 契约 → AI Provider 契约 → 各环节小用例 → 大场景集成验证 → 组合编排用例（R1、R2），不在应用层复制领域算法。
- 词频分类记录（`knowledgePointVocabularyClassifications`）的写入由独立变更补齐；大场景描述不依赖其是否落地——首轮排期可能是 4 个 ENCODE（分类缺失，初始流利度恒为 0）或 RETRIEVE 各档（分类已写入），场景的结构性断言两种情形都成立。
- 当前 Domain 已有本地规则生成和 `judgeTask` 规则评判，但没有 AI Provider 调用能力；`test/core-flow.jest.test.ts` 使用桩，`test/domain-functions.jest.test.ts` 执行真实领域函数。本文描述的 AI Provider、应用用例和 Repository 仍属于待实现的应用层设计。

## SQLite Repository 实施计划

### 目标与约束

- 生产数据使用 SQLite + Drizzle ORM + `better-sqlite3`；所有持久化 Repository 共用同一个数据库连接和关系表，测试继续可使用内存 Repository。
- 关系表是唯一持久化真相。`LearningStateRepository` 是完整领域状态的聚合读写视图，不另存一份 JSON 快照；其余端口对相同表进行细粒度读写。
- 首期保留 `LearningStateRepository.save(next, expectedRevision)` 契约。保存时在数据库事务内检查全局 revision，以数据库事务开始时的当前状态为基准计算差异，只插入、更新或删除变化的行，不清空并重建全库。
- 增设单行 `repository_meta`（例如固定键 `main`、`revision`）作为共享乐观并发版本。**每个修改共享业务表的 Repository 写事务都必须检查并递增同一个 revision**；快照保存使用调用方传入的 `expectedRevision`，细粒度端口在事务开始时读取当前 revision 并在成功提交前递增。任何写入路径不得绕过此机制。
- revision 不匹配时回滚并抛出 `ConcurrencyConflictError`。应用层只有在能从最新状态重新执行整个决策时才重试；AI 请求、文件解析等外部工作不放进数据库事务。
- 所有端口声明的原子写入边界各自对应一个 SQLite 事务；不引入跨用例大事务。外键约束在连接初始化时开启。

### Schema 范围

使用 Drizzle schema 管理关系表、外键、唯一约束、检查约束和索引；版本化 SQL migration 是 schema 演进的唯一来源。领域对象有明确身份、独立生命周期或关系查询需求的部分使用关系表；任务内容、词汇估计细节、初始化证据、作答 submission/judgement/settlement、提取元数据等稳定整体读写的结构使用 JSON 文本列，并在仓储边界反序列化和校验。

首版表覆盖完整 `LearningState`：

- 学习者与词汇评估：`learners`、`vocabulary_assessments`、`vocabulary_assessment_tasks`、`vocabulary_assessment_attempts`；词汇估计历史可单独建表或以 JSON 保存，并明确当前估计的关联方式。
- 材料分析：`materials`、`material_analyses`、`knowledge_points`、`material_analysis_items`、`material_analysis_occurrences`、`material_analysis_unmatched_items`、`material_analysis_unmatched_occurrences`。
- 学习范围：`learning_goals`、`goal_materials`、`goal_knowledge_points`、`goal_knowledge_point_sources`、`knowledge_point_vocabulary_classifications`、`learner_knowledge_points`。
- 计划与作答：`study_plans`、`study_plan_tasks`（显式保存顺序）、`learning_tasks`、`task_attempts`。
- 并发元数据：`repository_meta`，保存全库 revision；初始化数据库时插入唯一主记录。

主键优先使用领域稳定 ID；关联实体使用领域自然复合键（例如目标与材料、目标与候选知识点、学习者与知识点）；一对多有序数组使用 `position` 列。关键唯一约束包括 `(learner_id, date)` 每日计划唯一、同一任务最多一条首次作答、同一分析中的知识点项唯一，以及各复合关系键唯一。删除行为采用限制或显式事务删除，不用级联删除学习历史。

### 仓储与事务映射

1. **Schema 与迁移**：定义上述 Drizzle schema、主外键和约束，生成初始 migration；建立数据库初始化、连接配置、外键启用、revision 初始化和迁移入口。
2. **共享事务/版本机制**：封装事务辅助器，使所有写端口以一致方式读取/检查 revision、执行短事务、递增 revision；快照 `save` 额外接受 `expectedRevision` 并做严格比较。
3. **状态聚合仓储**：实现 `LearningStateRepository.load()`，从各关系表按稳定顺序加载并组装完整状态；实现 `save()` 的全实体差异同步。差异同步按外键依赖顺序写入，删除按反向依赖顺序执行； revision 检查、差异写入和递增必须在同一事务内。
4. **材料仓储**：`saveMaterialWithAnalysis` 在一个事务内写材料、分析、知识点、分析项、出现记录及未匹配记录；AI 分析在事务外完成。
5. **目标材料仓储**：实现目标/材料/分析/范围读取；`saveGoalMaterial` 在一个事务内保存目标、材料关联、知识点、候选和来源。新分析版本以新分析记录保存，并按用例规则更新关联，不覆盖历史分析。
6. **知识点选择仓储**：实现选择上下文聚合查询；`saveKnowledgePointSelection` 在一个事务内更新候选状态并写入新增分类和学习者知识状态。
7. **任务上下文仓储**：按目标和知识点关联候选、知识点、来源分析对应的材料及目标学习者最新词汇估计，批量查询后组装 `TaskGenerationContext`；来源分析和材料须遵循目标固定的分析版本。
8. **运行时接线**：提供单一 SQLite 数据库模块和 Repository factory，应用运行时创建一次连接并注入全部仓储；静态词汇索引、词义库等只读本地资源端口继续采用现有实现。

### 验收条件

- 每个 `LearningState` 集合都能从关系表完整往返；保存仅变更对应记录，重复保存无额外业务差异。
- 所有仓储读写共享同一数据库；通过任一端口写入后，`LearningStateRepository.load()` 能立即读到一致结果。
- 各多表写操作在中途故障时完整回滚，revision 不递增；成功时 revision 恰好递增一次。
- 旧 revision 的快照保存会冲突；任一细粒度写入发生后，先前加载的旧快照也会冲突，且不会覆盖细粒度写入。
- 关闭并重新打开 SQLite 文件后数据仍完整；外键、唯一约束和关键查询索引生效。
- Repository 契约测试覆盖空库、已有数据、更新/删除、事务失败、并发冲突和重启重载；现有应用行为测试仍可用内存实现运行。

实施顺序：Schema/migration → SQLite 基础设施与 revision 协议 → 状态聚合与差异同步 → 其余细粒度仓储 → 运行时接线 → SQLite Repository 契约验证。首期不做旧格式生产数据迁移；如已有需保留的数据，再单独定义导入迁移步骤。
