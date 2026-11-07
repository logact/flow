# 新算法执行契约 v0.2

权威规范：[algorithm.md](./algorithm.md)。本文件冻结实现边界与状态机；D1–D8 原型参数见[决策台账](./new-algorithm-decisions.md)，由用户授权制定，后续可调整。

## 跨模块数据

| 契约 | 生产者 | 消费者 | 必须保持的不变量 |
|---|---|---|---|
| C1 词与轴状态 | T01 schema、T02 回写 | T03 导入、T12 调度、T14 历史 | F_R/F_P 独立；初始 H=3600000ms；轴锚可空；词级共享锚独立存储；tick 只由有效完成增加 |
| C2 版本材料 | T03 仓储、T06/T08/T10 生成器 | T04 签发、T13 恢复 | 词义版本、档位、公开题面、私有答案键和校验依据一同冻结；失效材料不可签发 |
| C3 实例 | T04 | T05/T07/T09/T11 UI、T13 生命周期 | 单词、单轴、单档；公开 DTO 由白名单构造；snapshot 与错误响应不得泄露答案键 |
| C4 作答与判定 | T04/T09/T11 | T02 回写、T13 重试 | 首次完整作答冻结；服务端判定；计时片段按序校验；uncertain 与服务失败均不扣分 |
| C5 生命周期 | T04/T13 | 所有任务路由、T14 | 每实例最多一个终态与一次结算；重复请求返回原结果 |
| C6 调度 | T12 | T04、正式页面 | 只由目标轴 F 定档；材料不可用重比其他候选；EMPTY 有原因和可空下次时间 |
| C7 事件 | T02/T04/T13 | T14 | instance_id/attempt_id 幂等；保存有效不变分与 null 速度；统计从真实事件计算 |

分档函数必须在每个轴满足：`F=0 → encode`，`0<F<20 → choice`，`20≤F<40 → cued`，`40≤F<60 → free`，`60≤F≤100 → fluency`。超出 0–100 拒绝。`purpose` 只标记派发原因。禁止将材料状态、旧认证字段或另一轴 F 纳入分档。

## 实例状态机

建议持久化状态名为 `issued`、`grading`、`grading_retry`、`completed`、`skipped`、`exited`、`invalid`。`grading` 表示首次完整 response 已持久化并冻结；短于 30 有效词的 P 作答仍为 `issued`，可继续编辑。`grading_retry` 保留 response/计时/材料版本，重试只能重做判定。无效后若用户重新开始，创建新 attempt 和新计时片段；不拼接原 attempt。

| 原状态 | 事件 | 新状态 | 结算 |
|---|---|---|---|
| issued | 合法完整提交 | grading | 无 |
| issued | 显式跳过/退出 | skipped/exited | 无 |
| issued | 计时无效或中断 | invalid | 无 |
| grading | 判定成功且有效 | completed | 原子更新目标轴、词级锚、tick 和事件一次 |
| grading | 不确定、服务或 schema 错误 | grading_retry | 无 |
| grading_retry | 重试判定成功 | completed | 同上，只一次 |
| grading_retry | 再次不可判定 | grading_retry | 无；记录有界重试 |
| 任意终态 | 重复同请求 | 原终态 | 返回原结果，不新增事件 |

`grading`/`grading_retry` 的退出与并发策略见 D6/D8。不得让先返回的响应覆盖已持久化终态。曝光结算遵守 D2：已在提交前曝光就随完成事务增强 H；只有反馈能曝光时，待反馈打开再单独增强 H 一次，须以实例唯一键幂等。中断、跳过、退出和 invalid 一律不更新 H、任何时间锚或 tick。

## 服务边界与错误

API 返回可区分的 `INVALID_INPUT`、`INSTANCE_CONFLICT`、`MATERIAL_PENDING`、`MATERIAL_FAILED`、`GRADING_RETRYABLE`、`ATTEMPT_INVALID`；最终 HTTP 映射由 T04/T13 确认。错误体仅包含代码、用户可读提示、实例 ID 和安全的重试信息，绝不包含答案键。`EMPTY` 的 reason 包括 `waiting_review`、`waiting_rescue`、`material_pending`、`material_failed`、`scope_empty`，`next_available_at` 无法确定时为 null。生成、判分单批次预算由 D5 注入，不得无限后台重试。

## 共用验证接口

T01 提供临时 SQLite 工厂、可控毫秒时钟、固定 ID 序列、可设置状态的材料库、判分 provider 桩与并发栅栏。新版测试命令为 `node test/run-new-algorithm-score-tests.cjs`、`node test/run-new-algorithm-db-tests.cjs`、`node test/run-new-algorithm-scenarios.cjs`；通用 LLM 基础设施仍用 `node test/run-llm-tests.cjs`。旧 DAG/任务流测试已移除，其历史运行日志只用于 T00 基线，不能作为新版通过证据。证据目录 `test-report/new-algorithm/<ID>/` 至少记录命令与退出码、版本、夹具、期望/实际、DB 前后与事件。浏览器证据额外包含截图、操作顺序及 instance_id。
