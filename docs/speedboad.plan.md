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

`goalId`、`learnerId`、目标标题、`targetFluency`、`materialId`、`analysisId`、`addedAt`；创建目标时同时传入 `now`。

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
4. 调用 `deriveInitialFluency`，再将返回的 `derived` 原样传给 `initializeLearnerKnowledgePoint`。
5. 保存选择变化及新增学习状态。

**输出与边界**

- 返回更新后的候选和新增学习状态。
- `excluded` 不删除历史学习状态或任务；需要取消的任务由后续 S07 决定。
- 已有学习状态不重复初始化；未完成定级时返回前置条件错误，本批变更不部分写入。

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
- 达到目标分数不等于复习毕业：达标后的到期任务固定为 `FLUENCY`，只有该维度通过最后一次 30 天间隔复习并标记 `graduated` 后才停止派题。
- 容量缩减时，排期决策负责给出 `cancelTaskIds` 和 `expireTaskIds`，应用层不自行决定取消或过期任务。
- 同一词族的任务在当日计划中重复出现时（如同词跨目标、同族不同词），在不打破优先级顺序的前提下拉开位置：相邻两次练习之间至少间隔 5 个其它任务；任务总数不足以拉开时保持原顺序。

**输出与边界**

- 返回 `DailyStudyDecision`，其中 `existing` 表示保留任务，`new` 只包含待生成的 `TaskSpecification`。
- 决策是暂态编排数据，尚未形成已保存的每日计划；状态发生变化时必须重新排期，不能沿用旧决策。

### S08：生成学习任务

**输入**

一个 `new` 位置对应的 `TaskSpecification`，以及应用层分配的 `taskId`、`learnerId`、`issuedAt`。

**应用层编排**

1. 根据 `specification.goalId` 和 `specification.wordId` 加载目标知识点及目标来源材料。
2. **应用层调用 AI Provider，根据 `TaskSpecification`、知识点和 `sourceMaterials` 生成 `GeneratedTask`。Domain 不直接调用 AI；当前 `generateLearningTask` 是本地模板生成路径，不代替本用例的 AI 生成路径。**
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

> Contemporary teams work in a world where digital tools are ubiquitous. When a project changes, a deliberate response is more useful than a rushed one. A resilient team learns from the setback, adjusts its plan, and keeps moving.

本场景将 `contemporary`、`ubiquitous`、`deliberate`、`resilient` 四个候选设为 `included`，其他候选保持 `undecided` 或设为 `excluded`。`deliberate` 使用“深思熟虑的”这一独立词义。

### 调用顺序与状态传递

| 步骤 | 应用用例 | 应用层动作 | 产物 |
| --- | --- | --- | --- |
| 1 | S01 | 创建小林，容量设为 5 | 持久化 `Learner` |
| 2 | S02 | 读取词表、抽样，创建不含选项和答案的词汇自评任务并保存测评 | 测评及服务端自评任务 |
| 3 | S03 | 提交全部 `known` 自评并完成测评 | 完成的测评、自评记录、`currentVocabulary = V0` |
| 4 | S04 | 提取材料文本并完成分析 | `Material`、`MaterialAnalysis` |
| 5 | S05 | 创建目标并加入固定分析版本 | 目标、材料关联、候选和来源 |
| 6 | S06 | 纳入四个重点候选并初始化 | 选择结果、四条学习状态 |
| 7 | S07 | 生成容量为 5 的排期决策 | 暂态 `DailyStudyDecision` |
| 8 | S08 × 5 | **由应用层调用 AI**，为五个 `new` 规格分别生成任务 | 五项暂态服务端 `LearningTask` |
| 9 | S09 | 一次性应用决策及全部新任务 | 持久化计划、五项 `issued` 任务 |
| 10 | S10 × 5 | 分别提交五项任务，其中 `ubiquitous` 有效但答错 | 五条首次作答 |
| 11 | S11 × 5 | 选择题使用规则评判；**非选择题由应用层调用 AI 评判**；阅读混合题合并规则与 AI 结果后统一结算 | 五个 `settled` 作答、五个完成任务、更新后的学习状态和 `V1` |
| 12 | S07 → S08 → S09 | 时间推进到 `ubiquitous` 的实际 `dueAt` 后重新排期，**由应用层调用 AI 生成复习任务**并保存计划 | 包含到期复习的新计划 |
| 13 | S12 → S07～S09 | 归档目标后再次请求计划 | 保留历史，不再生成该目标的新任务 |

第 7 步的五个 `new` 规格依次用于：`resilient / ENCODE`、`ubiquitous / RETRIEVE-R-choice`、`deliberate / RETRIEVE-P-cued`、`contemporary / FLUENCY-R`、`resilient / FLUENCY-P`。S07 只产生这些规格，S08 才通过应用层 AI Provider 生成具体题目，S09 才将任务和计划一起持久化。

### 大场景验收

1. 同一套用例契约可以先在内存 Repository 上运行，再切换到 SQLite Repository 运行，不需要修改用例流程。
2. 每个写用例只使用前序用例持久化后的 ID 和状态，不依赖内存对象引用；每次写入后重新加载，`validateLearningState` 不返回约束错误。
3. S04、S08 的外部能力失败时，不出现部分写入的分析或每日计划；S02 不调用外部 AI，只保存完整的自评任务和测评。
4. S07 不创建任务或计划；S08 不持久化孤立任务；只有 S09 能将完整计划和任务集合一起写入。
5. S10 重试使用同一 `attemptId` 不会增加首次作答；S11 重试不会重复结算。
6. 五项任务结算后均为 `completed`，答错项也保留真实评判；流利度、复习计划和词汇估计来自各自结算快照。
7. S09 的公开任务响应不包含答案、阅读证据或场景表达评分标准。
8. 到期复习由新的 S07～S09 调用产生；归档后历史仍可加载，但不再出现该目标的新任务。
9. 应用用例测试使用可控的 Fake AI Provider 返回固定题目和评判，验证编排、失败与幂等；真实供应商调用单独做 Live 验证。非选择题的 AI 评判必须以 `judgedBy = 'ai'` 进入同一 Domain 结算路径。

## Prototype 边界

- 实现顺序为：Repository 契约 → AI Provider 契约 → 各环节小用例 → 大场景集成验证，不在应用层复制领域算法。
- 当前 Domain 已有本地规则生成和 `judgeTask` 规则评判，但没有 AI Provider 调用能力；`test/core-flow.jest.test.ts` 使用桩，`test/domain-functions.jest.test.ts` 执行真实领域函数。本文描述的 AI Provider、应用用例和 Repository 仍属于待实现的应用层设计。
