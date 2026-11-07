# 新算法执行契约 v0.3（T00 冻结；O1–O3 原型默认值已确认）

权威规范：[algorithm.md](./algorithm.md)。本契约冻结规范已明确的跨模块字段与不变量，并记录用户确认的 O1–O3 可调整原型默认值，供下游实现和验收。D1–D8 的适用状态见[决策台账](./new-algorithm-decisions.md)；与现行规范冲突的旧参数不得进入新版实现。

## 跨模块数据

| 契约 | 生产者 | 消费者 | 必须保持的不变量 |
|---|---|---|---|
| C1 词与轴状态 | T01 schema、T02 回写 | T03 导入、T12 调度、T14 历史 | F、FLUENCY 达标证据、learning_complete、review_level、graduated、due_at 均按 R/P 独立；词毕业是两轴毕业的汇总；词级冷却锚共享；tick 只由有效完成增加 |
| C2 版本材料 | T03 仓储、T06/T08/T10 生成器 | T04 签发、T13 恢复 | 词义版本、档位、公开题面、私有答案键和校验依据一同冻结；失效材料不可签发 |
| C3 实例 | T04 | T05/T07/T09/T11 UI、T13 生命周期 | 仅连接任务为单词、`axis=both`；其余为单词、单轴、单档；公开 DTO 由白名单构造；snapshot 与错误响应不得泄露答案键 |
| C4 作答与判定 | T04/T09/T11 | T02 回写、T13 重试 | 首次完整作答冻结；服务端判定；计时片段按序校验；uncertain 与服务失败均不扣分 |
| C5 生命周期 | T04/T13 | 所有任务路由、T14 | 每实例最多一个终态与一次结算；重复请求返回原结果 |
| C6 调度 | T12 | T04、正式页面 | R/P 各自 `due_at_a` 排期；已到期复习轴→已到期学习轴→容量允许的新词；同词共用 7 tick/20 分钟冷却；未来 41 天按轴预约；材料不可用重比其他候选；EMPTY 有原因和可空下次时间 |
| C7 事件 | T02/T04/T13 | T14 | instance_id/attempt_id 幂等；记录目标轴前后 F、review_level_a、due_at_a、轴/词毕业和容量变化；保存有效不变分与 null 速度；统计从真实事件计算 |

导入时按 `algorithm.md` 中词汇量 V 与可比词频排名 rank 映射 R/P 初分（60/40、40/20、20/5 或 0/0）。仅 0/0 词签发一次连接任务，确认后两轴为 5，计一次 tick；非零估计初分词准入后直接按各轴分数派题，0 分轴从 choice 开始。估计分不设置 FLUENCY 通过或毕业证据。学习分档为：`0≤F<20 → choice`，`20≤F<40 → cued`，`40≤F<60 → free`，`60≤F≤100 → fluency`；定期复习固定为对应轴 FLUENCY。超出 0–100 拒绝。`purpose` 只标记派发原因。禁止将材料状态、旧认证字段或另一轴 F 纳入目标轴分档。

一轴达到目标且有有效 FLUENCY 通过，就从该轴通过日独立排 1、3、7、30 个本地日的相邻复习；每次通过只推进该轴，失败只退该轴级别或当天补练。另一轴可仍在学习或有不同复习日期。各轴完成自己的 30 天复习后 `due_at_a=∞`；两轴均毕业才词毕业。每次结算重新投影逐日总容量，但不得改写另一轴已确定排期。

## 实例状态机

建议持久化状态名为 `issued`、`grading`、`grading_retry`、`completed`、`skipped`、`exited`、`invalid`。`grading` 表示首次完整 response 已持久化并冻结；短于 30 有效词的 P 作答仍为 `issued`，可继续编辑。`grading_retry` 保留 response/计时/材料版本，重试只能重做判定。无效后若用户重新开始，创建新 attempt 和新计时片段；不拼接原 attempt。

| 原状态 | 事件 | 新状态 | 结算 |
|---|---|---|---|
| issued | 合法完整提交 | grading | 无 |
| issued | 显式跳过/退出 | skipped/exited | 无 |
| issued | 计时无效或中断 | invalid | 无 |
| grading | 判定成功且有效 | completed | 连接同时初始化双轴；其余只更新目标轴分数/复习/排期，再更新词级锚、容量、tick 和事件一次 |
| grading | 不确定、服务或 schema 错误 | grading_retry | 无 |
| grading_retry | 重试判定成功 | completed | 同上，只一次 |
| grading_retry | 再次不可判定 | grading_retry | 无；记录有界重试 |
| 任意终态 | 重复同请求 | 原终态 | 返回原结果，不新增事件 |

`grading`/`grading_retry` 的退出与并发策略见 D6/D8。不得让先返回的响应覆盖已持久化终态。旧 D2 半衰期增强不参与本版排期或结算。中断、跳过、退出和 invalid 一律不更新分数、排期、冷却锚或 tick。

## 服务边界与错误

API 返回可区分的 `INVALID_INPUT`、`INSTANCE_CONFLICT`、`MATERIAL_PENDING`、`MATERIAL_FAILED`、`GRADING_RETRYABLE`、`ATTEMPT_INVALID`；最终 HTTP 映射由 T04/T13 确认。错误体仅包含代码、用户可读提示、实例 ID 和安全的重试信息，绝不包含答案键。`EMPTY` 的 reason 包括 `today_complete`、`capacity_insufficient`、`cooldown_wait`、`material_pending`、`material_failed`、`scope_empty`，`next_available_at` 无法确定时为 null。生成、判分单批次预算由 D5 注入，不得无限后台重试。

## 共用验证接口

T01 提供临时 SQLite 工厂、可控毫秒时钟、固定 ID 序列、可设置状态的材料库、判分 provider 桩与并发栅栏。新版测试命令为 `node test/run-new-algorithm-score-tests.cjs`、`node test/run-new-algorithm-db-tests.cjs`、`npm run test:new-algorithm-scenarios`；通用 LLM 基础设施仍用 `node test/run-llm-tests.cjs`。旧 DAG/任务流测试已移除，其历史运行日志只用于 T00 基线，不能作为新版通过证据。证据目录 `test-report/new-algorithm/<ID>/` 至少记录命令与退出码、版本、夹具、期望/实际、DB 前后与事件。浏览器证据额外包含截图、操作顺序及 instance_id。


## 原型实施默认值 O1–O3（用户已确认）

下表记录用户批准的可调整原型值。它们补足 `algorithm.md` 留给实现的边界，不改变规范中的计分、优先级或 R/P 独立排期规则。

| ID | 原型默认值 | 受影响节点 | 验收要求 |
|---|---|---|---|
| O1 | 用户按本地日分别设置整数任务容量及每日可训练时间窗口，不从历史自动估容量。新词准入先检查最短路径所需任务名额；同词首日任务的时间可行性按保守最短冷却下界计算：未有 7 个其他有效任务完成时，每两个相邻同词任务至少间隔 20 分钟；该下界不包含作答时长。训练不足时保留原 `due_at`、显示逾期并优先处理，停止准入会造成未来超容量的新词 | T03、T12、T13、V01、V05、V08 | 覆盖容量输入、时间窗边界、最短路径、20 分钟等待、未完成后原 due 保留及停止准入 |
| O2 | 41 天容量预约按理想成功路径计算：已知初分与目标所需的最少学习任务都在预计日期完成、无失败，达标 FLUENCY 通过后按各轴第 1/4/11/41 天预留。实际结果只重算受影响轴尚未执行的条件预约，另一轴确定 `due_at` 不变。目标变化后按新目标重审该轴证据；若轴不再满足达标/毕业条件，撤销该轴未执行预约并从当天学习队列恢复 | T02、T12、T13、V05 | 覆盖非默认目标、初分跳档、两轴错日、失败及目标变化后的逐轴预约重算 |
| O3 | 后续复习日期从本次有效结算的用户本地日计算：通过后加升级间隔；有效未通过但未降分时加退级间隔；降分且低于目标则该轴 `due_at` 为失败当天。逾期成功从实际完成日开始下一间隔，不按旧 due 追赶 | T02、T12、T13、V05 | 覆盖按时与逾期通过、有效未通过、降分补练及跨本地日的 due/capacity 变化 |

这些值是可调整的原型策略，测试和报告须标明所用版本；不表示它们是 `algorithm.md` 的普遍性算法结论。不得回写 `algorithm.md` 来重复这些实现决定。
