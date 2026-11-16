# Loop5 实施计划

## Decisions

- `materilaAnalyzeOptimize.decision.md`：材料候选生成、按需解析及独立发音补全；解析需可持久化、可恢复，进入页面不自动触发 LLM。
- `storage-backend.decision.md`：启动时通过服务端 `FLOW_STORAGE=memory|sqlite` 选择仓储，默认 memory，非法值报错；两种后端共用运行时初始化。

## 场景

### scenario1：启动时选择学习状态存储

#### include decision

- `storage-backend.decision.md`

#### description

无配置时保持 memory 行为；显式配置 sqlite 时使用 SQLite 仓储。两种后端均经过一致的运行时构造和种子初始化；非法配置清晰失败。切换后端不迁移或删除另一后端数据。

#### impl plan

**domain**：不涉及领域模型变更；确认两个仓储满足同一应用仓储契约。

**service**：在服务端启动时解析并校验 `FLOW_STORAGE`，通过仓储工厂构造 memory 或 SQLite 实例；抽象 `FlowRuntime.repository` 的具体类型；统一种子与初始化失败处理。沿用现有 SQLite 路径配置及迁移入口，补充 runtime 集成覆盖。

**UI**：不涉及 UI；补充 `.env.example` 或运行文档，注明服务端变量、默认值及 SQLite 路径。

### scenario2：生成材料的本地候选与待解析状态

#### include decision

- `materilaAnalyzeOptimize.decision.md` 的“文本提取与本地候选生成”及候选可见性决策。

#### description

材料导入完成本地文本筛选、词形归并和词义库匹配；单义词直接确认，多义候选保留语境并标为待解析。进入详情或目标页只读取状态，不自动调用 LLM。

#### impl plan

**domain**：检查并补足候选、已确认、待解析、失败等状态及转换；未解析多义词不得作为最终知识点。

**service**：核对当前 `MaterialAnalysis` 保存内容；如候选未持久化，扩展仓储、SQLite schema/迁移及 DTO。导入阶段只运行确定性本地处理。

**UI**：详情页展示待解析候选、语境和数量；目标选择区区分已解析知识点与待解析候选，不在页面加载时启动解析。

### scenario3：用户按需解析候选并恢复部分结果

#### include decision

- `materilaAnalyzeOptimize.decision.md` 的后台 LLM 消歧、翻译、材料级批处理、单项重试及目标提交仅解析所选候选决策。

#### description

用户从材料详情启动待处理候选解析，或在目标提交时仅解析所选候选。结果逐项持久化；失败可重试，重复操作幂等，刷新/重启后可查询状态。部分失败清晰反馈，不为失败项生成任务。

#### impl plan

**domain**：定义候选级处理中、成功、失败状态及合法转换，表达失败原因和已完成阶段；操作结果支持部分成功。

**service**：实现显式触发、并发去重、幂等操作标识和状态查询；解析/翻译结果分项保存。根据 scenario1 配置使用的仓储实现持久化；避免进程内 `Set` 作为唯一队列状态。目标提交校验候选归属与权限，只将成功解析的选择纳入目标和任务。

**UI**：详情提供批量解析及失败项重试，显示进度/结果；目标选择和提交反馈明确标记待解析候选，部分失败时保留草稿及失败项。

### scenario4：发音独立补全

#### include decision

- `materilaAnalyzeOptimize.decision.md` 的独立发音补全决策。

#### description

发音查询不阻塞材料主要分析完成；发音缺失或查询失败不改变知识点分析状态，且可独立补齐和重试。

#### impl plan

**domain**：发音数据允许缺省，发音补全状态与分析主体状态分离。

**service**：分析主体保存完成后独立触发发音查询，去重/限流并记录失败；单项重试不回滚已有分析结果。

**UI**：展示缺失、加载或失败状态及单独重试入口，不将发音失败显示为材料分析失败。

## 冲突与依赖

- `storage-backend.decision.md` 明确替代 loop2 的“运行时不启用 SQLite”限制；实施需验证 SQLite 适配器和迁移能够支持完整运行时状态。若集成验证发现仓储契约不兼容，应先修复适配器，再启用该场景。
- scenario2 是 scenario3 的前置；scenario1 应先于依赖持久化的候选/解析场景完成。
- SQLite 持久化的解析状态不等同于已实现可重启后台 worker；需在 scenario3 明确任务执行与进程重启后的恢复机制，不能以持久化状态冒充任务自动续跑。

## 执行顺序与实施记录

1. scenario1：配置选择仓储及验证运行时集成。
2. scenario2：候选状态持久化与本地候选展示。
3. scenario3：按需解析、状态恢复、失败重试及目标提交流程。
4. scenario4：发音独立补全。

每个场景完成后单独记录变更范围、验证结果及遗留事项，并按 loop5 流程提交。

## 实施进度

- 完成：场景一仓储选择已接入 `FLOW_STORAGE` / `FLOW_SQLITE_PATH`。运行时 smoke 验证：默认 memory 与 `FLOW_STORAGE=sqlite FLOW_SQLITE_PATH=/tmp/flow-loop5-runtime.sqlite` 均成功初始化种子；`FLOW_STORAGE=bogus` 清晰报错。
- 完成：场景二实现本地候选生成、单义词确认、候选持久化和材料详情展示；导入不调用消歧 LLM 或发音词典。
- 完成：场景四发音状态与分析状态分离；知识点详情可独立重试，查询处理中/失败/成功均有持久化状态，材料导入不等待词典查询。
- 验证记录：`test/material-import.jest.test.ts` 更新为 loop5 语义后 22 项通过；SQLite 仓储 25 项、目标加入材料 16 项通过；`npx tsc --noEmit --pretty false` 通过；`npx next build` 成功（存在 pdfjs-dist externalization 与动态文件访问警告）。
- 场景二进展：SQLite 原先拒绝已完成分析的候选状态增量更新；仓储现允许分析身份/版本/完成时间不变的候选精化。仓储测试 25 项通过，SQLite 实际写入并重新加载 `processing` 候选成功。
- 场景三进展：目标页可选择材料中的待解析候选；目标创建仅解析提交的材料/词元组合，成功后将其知识点加入选择，失败时拒绝创建并保留页面草稿。服务端校验材料归属及分析版本；`test/goal-add-material.jest.test.ts` 16 项通过。仍需补充候选提交集成测试并复核刷新/重复提交恢复行为。
- 场景四验证：`test/pronunciation.jest.test.ts` 与材料导入、SQLite 仓储、目标创建用例合计 66 项通过；类型检查通过。生产构建在编译和静态生成后被 Next.js 的安全版本检查中止，需升级框架版本后重试。
