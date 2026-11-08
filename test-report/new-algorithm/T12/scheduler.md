# T12 调度与容量（DONE）

## 本次实现

- review → learning → new 的稳定优先顺序；旧候选按本地到期日、word ID、R→P 排序。新词比较先按可比词频来源分组（当前书优先），再按组内词频、归一化目标缺口和 word ID；缺失频率排最后。
- `getScheduleDecision` 在临时库路径汇总 due 候选、每词冷却锚、当天容量/候选预约、训练窗口与当前词义版本材料，再通过 `chooseScheduleCandidate` 返回候选或 `today_complete`、`capacity_insufficient`、`cooldown_wait`、`material_pending`、`material_failed`、`scope_empty`、`training_window_closed` 等 EMPTY 原因。冷却结束时间涉及 7 tick 或 20 分钟两条路径，当前不可准确预测时返回 null；冷却/材料不可用的候选不会阻塞后续可用候选；capacity 正好被该候选自己的预约占满时仍可派发；夏令时跨界后下一训练窗口时间按 IANA 时区计算；没有 introduction 预约的双零词返回 `capacity_insufficient`；准入验证了剩余冷却时间/当天容量不足拒绝，以及预约写入中断时原有 active 预约回滚保留。
- `loadScheduleCandidates` 从隔离 schema 读取 due 轴/新词预约，按各词 IANA 时区转换日期；毕业轴不派发；材料需为当前 `meaning_version` 下未使用的 ready 版本。
- 每日容量投影覆盖今天至第 41 天，分列 completed、determined、conditional、introduction；轴级预约可以事务式重算并保持另一轴数据。新词准入事务校验当前任务量、数据库训练窗口到结束的剩余时间、材料和 42 日投影，并以稳定 ID 写入 introduction 与 R/P 条件预约；测试覆盖时间/容量拒绝、重放幂等和写入失败回滚。默认按理想最短路径同日达标，并为 R/P 分别预留；调用者也可传入不同预计达标日。失败与目标变化后的真实重算由 T02 结算联调。
- 正式 task service 已在签发事务内按每个词条时区调用 `getScheduleDecision`，仅签发 DB chooser 选中的候选；EMPTY 返回 chooser 的具体原因与可计算的 next availability。候选必须在实际派题本地日有有效容量预约；逾期轴保留原 `due_at`，但要有今日预约才能派发。材料待生成、冷却未知 ETA、训练窗恢复时间和不支持的后续题档均有明确结果。

## 验证

- 容量不足 EMPTY：未来 41 个本地日内，存在可执行候选且容量可用（含该候选有效预约）时，返回其最早可执行时间；缺少可靠未来证据时仍返回 `null`。
- `npx jest --runInBand test/new-algorithm-scheduler.jest.test.cjs test/new-algorithm-task-service.jest.test.cjs`：27/27 通过。
- `npx jest --runInBand`：15 suites / 170 tests 通过。
- `git diff --check`：通过。
- `npx tsc --noEmit`：仍只有已知的两个非本次错误：`app/score-history/page.tsx:57`、`lib/manual-test-fixtures.ts:183`。

## 范围边界

- DB chooser 与正式 task service 已完成接线；当前 task service 可实际签发连接/choice。候选为 cued/free/FLUENCY 时返回 `task_stage_unavailable`，对应阶段签发由 T13 扩展。该限制不改变 scheduler 的候选和容量决策。
- 材料作业生成/重试由 T03/T06 管理；T12 读取当前 meaning version 的材料状态、跳过不可用候选并返回 `material_pending` 或 `material_failed`。
- R/P 预计完成日期默认使用获批的理想最短路径同日估计；调用方可分别传不同预计日期。实际答题时长未由规范定义，准入按 O1 冷却下界验证。
- V05 人工双轴验收与浏览器端到端验收属于独立门禁，不作为 T12 自动调度代码测试的替代或虚假 PASS。
