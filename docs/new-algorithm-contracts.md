# 新算法执行契约 v0.3（T00 冻结；实现边界另列 OPEN）

权威规范：[algorithm.md](./algorithm.md)。本契约冻结规范已明确的跨模块字段与不变量，供下游按接口开发；不替代规范明确保留的实现边界。OPEN 项见本文末尾，相关节点在门槛解除前可做隔离实现，但不得标 DONE。D1–D8 的适用状态见[决策台账](./new-algorithm-decisions.md)；与现行规范冲突的旧参数不得进入新版实现。

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


## T00 冻结范围与 OPEN 实现边界

下表是契约审计结论。OPEN 表示产品/实现选择尚未确认，不得由实现者写成隐含常量；不影响已明确的接口先行实现。

| OPEN ID | 未决边界（不新增算法规则） | 受影响节点 | 解锁条件 |
|---|---|---|---|
| O1 | 每日容量如何取得、用户未做满时如何重排、当天可训练时间窗口及“剩余时间足够”的可计算口径 | T03、T12、T13、V01、V05、V08 | 冻结容量输入与时间可行性口径；完成容量不足/等待的集成验证 |
| O2 | 已有初分、非默认目标、两轴不同达标日/一轴失败时的条件预约预算与目标变更后的重排规则 | T02、T12、T13、V05 | 冻结预约估算规则；逐轴验证目标调整、失败与错开达标，不改另一轴已确定 due_at |
| O3 | 有效未通过或跨日逾期后成功时，下一次复习间隔的日期锚点；规范规定原 due 保持逾期、未通过按退级间隔重排，但没有唯一规定计算后续日期的锚点 | T02、T12、T13、V05 | 明确并记录日期锚点选择；用有效未通过与跨日逾期成功场景验证实际 due_at 和容量重算 |

初审曾提出 O3/O4；审查确认其内容已由 D3–D6 的已确认原型选择覆盖，故已删除，不得重复列为未决。除上述 OPEN 外，C1–C7 字段与 `algorithm.md` 已明确的分档、轴独立排期/毕业、任务优先级、容量视图范围和错误不结算等行为可供实现。 OPEN 解锁后由协调者把相应节点从 BLOCKED/受限状态改为 READY，并更新受影响证据；不得回写 `algorithm.md` 来消除实现选择。
