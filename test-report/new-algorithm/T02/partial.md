# T02 原子计分核证据

- 输入：`docs/algorithm.md` 分档表、提取分表、R/P 流利公式；目标分数边界 0/20/40/60/100 与速度边界。
- 期望：纯函数唯一分档、绝对计分、有效不变分和无效不变分分离；正式事务仅结算目标轴一次。
- 实际：`lib/new-algorithm-score.ts` 实现纯函数，`lib/new-algorithm-settlement.ts` 实现冻结作答原子结算及反馈曝光补结算。D2 按用户授权写入决策台账。正式任务服务接入属依赖 T03 的 T04，尚未发生。
- `node test/run-new-algorithm-score-tests.cjs`：退出 0，5/5。覆盖 0+/20−ε/40−ε/60−ε、R 149/150/200/225/300、P 24.9/25/42.5/60、目标失败、整体失败与无效/服务失败。
- `node test/run-new-algorithm-db-tests.cjs`：退出 0，11/11；其中 T02 用例覆盖 ENCODE 完成/重放、R/P choice/cued/free 成败、R/P FLUENCY 速度直写且可下降、整体失败有效不变分、uncertain 待重试、反馈曝光仅增强一次、注入事件失败后全事务回滚、缺冻结曝光证据拒绝增强、invalid 终态不能结算。
- DB 快照：ENCODE 前 R/P=0、H=3600000、tick=0、锚 null；后 R=5/H_R=5400000/tick=1、P 不变、completed 事件 1。uncertain 前后分数 80、H=3600000、锚 null、tick=0，冻结作答保留并标 `grading_retry`。反馈曝光前 H=3600000，首次打开后 5400000，重复打开仍 5400000，tick 不变。故障注入后分数、终态、tick、事件均回滚。
- 边界：服务端答案判定、材料和计时有效性由 T04/T08/T10 提供；本模块只接受已冻结的服务端判定。正式入口尚未接入，本证据不代表 S1/V01 完成。
