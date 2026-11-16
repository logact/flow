# loop1 场景实施计划

## 场景

### 场景一：材料导入、分析与目标创建

#### include decision
- [材料保存与分析解耦](material-import-analysis.decision.md)
- [目标创建与材料重复关联处理](goal-creation-and-material-conflicts.decision.md)
- `human-verify.record.md` 第 16 条：材料导入与分析分开处理
- `human-verify.record.md` 第 17 条：独立材料管理页及材料详情

#### description
用户在材料管理页查看材料及分析状态，打开详情查看分析得到的知识点并筛选、排序。用户先保存材料，再显式触发分析；分析完成后可将材料加入一个或多个目标。材料重复关联时需知情确认，创建端再次校验并避免重复提交。分析中的或失败的材料不可用于目标创建。

#### impl plan
**domain**
- 复用材料分析 `pending`、`analyzed`、`failed` 状态及材料与分析版本关系；明确只允许已分析材料参与目标创建。
- 明确同一材料可关联多个目标、同目标同分析版本保持幂等的领域规则。
- 材料详情知识点只取当前材料最新分析的结果；空结果、分析中和失败状态有明确表达。

**service**
- 将材料保存与分析触发拆成独立用例；实现分析状态查询、显式启动、失败重试及并发启动去重。
- 目标创建由服务端生成 ID；提供关联预检查，提交时二次校验重复关联确认、材料有效性及请求去重。
- 确保分析失败保留材料，重复创建请求返回既有结果，不产生部分目标。
- 提供材料列表及单材料详情查询；详情支持按词条搜索、出现次数或名称排序。

**UI**
- 导入后展示材料及分析状态，提供单独的分析、失败重试操作和处理中反馈。
- 从目标管理进入独立材料管理页；列表可打开详情，查看当前材料的分析知识点并搜索、排序。
- 目标创建时展示所选材料已关联的目标，允许取消或确认；材料选择变化后重新检查。
- 提交期间禁用重复操作，成功后使用服务端返回的目标 ID 并刷新列表。

#### implementation status
- 核验结果：已完成。现有代码覆盖材料保存与显式分析、失败重试、材料管理列表及详情知识点筛选排序，以及目标创建前后关联校验和请求去重。
- 核验依据：`app/api/materials/route.ts`、`app/api/materials/[id]/analysis/route.ts`、`app/api/materials/[id]/route.ts`、`app/materials/library/page.tsx`、`app/materials/[id]/page.tsx`、`app/api/goals/create/route.ts`、`app/goals/page.tsx`。
- 验证：`test/material-import.jest.test.ts`、`test/goal-add-material.jest.test.ts` 均通过；API 的页面交互通过代码路径核验，当前没有对应的端到端 UI 测试。
- 实施提交：`31e326f`（该提交一次实现了 loop1 全部场景）。

### 场景二：目标管理与学习进度

#### include decision
- [目标展示页面学习进度优化](goal-progress-display.decision.md)
- `human-verify.record.md` 第 18 条：目标页区块展示

#### description
用户从目标管理页识别并进入目标，在目标详情中查看已选知识点的掌握进度。摘要统计仅针对选择学习的知识点，R/P 均毕业才算完成。

#### impl plan
**domain**
- 统一完成、进行中、未初始化的判定及 R/P 平均值口径，保留无数据与数值 0 的区别。

**service**
- 目标详情查询返回进度汇总及目标所需摘要字段；确保汇总与知识点列表使用同一数据和选择范围。

**UI**
- 目标列表按目标区块展示，明确创建及详情入口，并覆盖空状态和窄屏。
- 目标详情展示完成率、数量、R/P 当前值与目标值、状态分类和下一步提示；正确呈现未初始化、空集合和加载错误。

#### implementation status
- 核验结果：已完成。目标详情 API 仅按 `included` 知识点计算完成率、分类数和 R/P 平均值；页面展示空集合、待初始化和完成状态。
- 核验依据：`app/api/goals/[id]/route.ts`、`app/goals/[id]/page.tsx`。
- 验证：完整 Jest 套件通过；`test/goal-status.jest.test.ts` 覆盖目标学习状态流转。构建通过，页面/API 类型检查完成。
- 实施提交：`31e326f`（该提交一次实现了 loop1 全部场景）。

### 场景三：知识点选择与材料来源筛选

#### include decision
- `human-verify.record.md` 第 19 条：知识点选择搜索、排序及来源材料多选筛选

#### description
用户在目标知识点选择页通过搜索、词频排序和来源材料筛选查找知识点；筛选和分页期间已选状态保持稳定。

#### impl plan
**domain**
- 确认单词词频、词族词频排序所依赖的数据字段及空值排序规则。

**service**
- 查询支持关键词、排序模式及多材料来源过滤；保证分页结果与过滤条件一致。

**UI**
- 增加搜索、排序方向提示、来源材料多选和清除筛选操作；筛选或分页更新列表时保留已选知识点。

#### implementation status
- 核验结果：已完成。目标知识点选择页面支持搜索、单词/词族词频排序及升降序、多材料筛选；页面明确筛选采用“任一来源匹配”，筛选时保留已选状态。
- 核验依据：`app/api/knowledge/selection/route.ts`、`app/goals/page.tsx`。
- 验证：完整 Jest 套件通过；`test/knowledge-point-selection.jest.test.ts` 覆盖选择状态用例。构建通过，页面/API 类型检查完成；当前没有对应端到端 UI 测试。
- 实施提交：`31e326f`（该提交一次实现了 loop1 全部场景）。

### 场景四：知识点库检索与学习详情

#### include decision
- `human-verify.record.md` 第 20 条：知识点库搜索、来源筛选、熟练度排序及详情
- [第 20–22 条实现口径](human-verify-20-22.implementation-decisions.md)：熟练度、复习日期、历史和分数变化口径

#### description
用户在知识点库中查找并按熟练度排序知识点，查看词族和来源材料；进入详情后查看未来复习计划、学习记录及分数变化。

#### impl plan
**domain**
- 确认熟练度排序依据及分数历史的时间和值口径，复用已有复习与学习记录定义。

**service**
- 提供支持搜索、来源多选过滤、熟练度排序的查询；详情聚合复习计划、学习记录和分数时间序列。

**UI**
- 列表展示词族及来源，提供搜索、筛选和排序；详情按时间呈现复习计划、记录与分数变化，并覆盖无记录状态。

#### implementation status
- 核验结果：已完成。知识点库支持搜索、来源材料多选、熟练度排序，并展示词族/来源；详情读取未来复习安排、作答记录和结算产生的真实分数变化。
- 核验依据：`app/api/knowledge/route.ts`、`app/knowledge/page.tsx`、`app/api/knowledge/[id]/route.ts`、`app/knowledge/[id]/page.tsx`、`docs/loop/loop1/human-verify-20-22.implementation-decisions.md`。
- 验证：完整 Jest 套件通过；构建通过，页面/API 类型检查完成。当前没有该查询与页面的专用端到端测试。
- 实施提交：`31e326f`（该提交一次实现了 loop1 全部场景）。

### 场景五：ENCODE 中文释义

#### include decision
- [ENCODE 页面中文释义归属决策](encode-sense-chinese-meaning.decision.md)
- [ENCODE sense 中文释义实施决策](encode-sense-chinese-meaning.implementation-decision.md)

#### description
ENCODE 页面依据当前知识点关联的 sense 展示稳定的中文释义；同词不同义项不互相借用释义。

#### impl plan
**domain**
- 将中文释义作为 sense/知识点领域数据，明确缺失值表达并保持与具体义项的关联。

**service**
- 调查创建、导入和补全链路，选定释义生成、校验及旧数据回填策略；任务读取当前 sense 的释义，必要时保存稳定快照。

**UI**
- ENCODE 展示当前义项的中文释义；缺失时呈现明确状态，不回退到其他义项的翻译。

#### implementation status
- 核验结果：已完成。材料分析时翻译并保存 sense 级中文释义；ENCODE 任务读取当前知识点的已保存值，缺失时 UI 显示“暂缺”。
- 核验依据：`lib/application/material-import.ts`、`lib/application/sense-meaning-translation.ts`、`lib/application/task-generation.ts`、`components/learning/TaskCard.tsx`、`docs/loop/loop1/encode-sense-chinese-meaning.implementation-decision.md`。
- 验证：完整 Jest 套件通过，项目构建通过。中文释义缺失、翻译失败及历史数据状态按实施决策明确显示为暂缺；当前没有专用翻译集成测试。
- 实施提交：`31e326f`（该提交一次实现了 loop1 全部场景）。

### 场景六：首页今日计划与答题反馈

#### include decision
- [首页手动刷新计划入口调整](home-plan-refresh.decision.md)
- `human-verify.record.md` 第 21 条：答对题目时全屏庆祝动画
- `human-verify.record.md` 第 22 条：保存用户学习进度
- [第 20–22 条实现口径](human-verify-20-22.implementation-decisions.md)：庆祝反馈与学习进度持久化

#### description
用户进入首页自动获得今日计划；答题结算后更新计划并保存进度。加载失败可重试。答对时显示全屏庆祝反馈，结束后继续学习。

#### impl plan
**domain**
- 梳理答题结算、学习进度推进和计划更新的边界，保证重复结算不会重复推进；明确进度需要持久化的数据范围。

**service**
- 首页加载与答题结算后刷新计划；持久化学习进度并处理幂等、失败恢复和重新进入后的恢复。
- 对外提供结算结果，确保首次提交、重试及历史结果一致，不在答题前暴露答案。

**UI**
- 移除常驻“刷新计划”，显示计划加载中状态；失败时提供明确的重试加载入口。
- 答对后显示全屏庆祝动画并在明确时长后结束，支持减少动态效果；答错展示正确答案和解释（对应 `human-verify.record.md` 第 9 条，需确认具体题型与解释来源后实现）。
- 明确显示学习进度保存状态及失败反馈；刷新或重新进入后恢复已保存进度。

#### implementation status
- 核验结果：已完成。答题反馈仅在结算成功后出现；答对庆祝全屏显示 2.4 秒、2.5 秒后继续，减少动态效果规则覆盖庆祝动画。学习领域状态使用 SQLite 持久化，作答结算幂等，计划刷新失败不会回滚已保存结算。
- 仓储说明：上述记录对应 `31e326f` 的历史实现。根据 loop2 人工评审第 8 条，当前应用运行时改回进程内存仓储；SQLite 仅保留为未启用实现。
- 核验依据：`app/page.tsx`、`app/globals.css`、`app/api/tasks/[id]/attempt/route.ts`、`lib/application/settle-and-refresh-plan.ts`、`lib/server/runtime.ts`、`lib/server/sqlite/repository.ts`、`docs/loop/loop1/human-verify-20-22.implementation-decisions.md`。
- 验证：完整 Jest 套件通过（24 suites、265 tests）；`test/settle-and-refresh-plan.jest.test.ts`、`test/judge-settle-task-attempt.jest.test.ts`、`test/sqlite-repository.jest.test.ts` 覆盖结算、重试及持久化；Next.js 生产构建和 TypeScript 检查通过。
- 实施提交：`31e326f`（该提交一次实现了 loop1 全部场景）。

## 冲突与待决策

- 未发现已确认 decisions 之间直接冲突。材料解耦与目标创建共享材料状态及关联边界，按场景一先落实材料分析状态，再接目标创建校验。
- 第 19 条的多来源筛选按“任一来源匹配”实现，并在知识点选择页明确告知；第 20 条熟练度、复习日期、历史排序和分数变化口径已由 `human-verify-20-22.implementation-decisions.md` 明确。
- ENCODE 中文释义由配置的 OpenAI 兼容 LLM 翻译并保存到具体 sense；缺失或翻译失败时明确显示暂缺，历史数据不串用其他 sense，依据 `encode-sense-chinese-meaning.implementation-decision.md`。
- 第 21 条动画时长、结束行为、减少动态效果，以及第 22 条 SQLite 持久化和重复提交语义，均已有 `human-verify-20-22.implementation-decisions.md` 的实施口径。
- 第 9 条错题答案与原因反馈不在 `loop1.plan.md` 当前计划范围内，且题型、解释来源及自由作答判定尚未决策；本计划仅标出与首页反馈链路的潜在关联，不将其纳入已确认实施范围。若要纳入，需先补充 decision。

## 建议依赖顺序

1. 场景一先稳定材料状态、来源关系和目标创建 API。
2. 场景二依赖目标详情查询；场景三和场景四依赖稳定的材料—知识点来源关系。
3. 场景五可独立实施，但释义生成与历史数据策略确定后再迁移数据。
4. 场景六先核对答题结算和计划刷新链路，再接入进度持久化与庆祝 UI。

## 文档边界

本文按 `loop1.plan.md` 汇总的 decisions 和第 16–22 条场景记录组织实施范围。六个场景均在提交 `31e326f` 中实现；本次逐场景核验代码与测试后，在对应章节记录实现状态和证据，没有发现需要继续修改的场景代码。
