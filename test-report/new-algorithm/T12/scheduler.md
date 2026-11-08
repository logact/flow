# T12 调度与容量（IN_PROGRESS）

## 本次实现

- review → learning → new 的稳定优先顺序；旧候选按本地到期日、word ID、R→P 排序。新词比较先按可比词频来源分组（当前书优先），再按组内词频、归一化目标缺口和 word ID；缺失频率排最后。
- `getScheduleDecision` 在临时库路径汇总 due 候选、每词冷却锚、当天容量/候选预约、训练窗口与当前词义版本材料，再通过 `chooseScheduleCandidate` 返回候选或 `today_complete`、`capacity_insufficient`、`cooldown_wait`、`material_pending`、`material_failed`、`scope_empty`、`training_window_closed` 等 EMPTY 原因。冷却结束时间涉及 7 tick 或 20 分钟两条路径，当前不可准确预测时返回 null；冷却/材料不可用的候选不会阻塞后续可用候选；capacity 正好被该候选自己的预约占满时仍可派发；夏令时跨界后下一训练窗口时间按 IANA 时区计算；没有 introduction 预约的双零词返回 `capacity_insufficient`；准入验证了剩余冷却时间/当天容量不足拒绝，以及预约写入中断时原有 active 预约回滚保留。
- `loadScheduleCandidates` 从隔离 schema 读取 due 轴/新词预约，按各词 IANA 时区转换日期；毕业轴不派发；材料需为当前 `meaning_version` 下未使用的 ready 版本。
- 每日容量投影覆盖今天至第 41 天，分列 completed、determined、conditional、introduction；轴级预约可以事务式重算并保持另一轴数据。新词准入事务校验当前任务量、数据库训练窗口到结束的剩余时间、材料和 42 日投影，并以稳定 ID 写入 introduction 与 R/P 条件预约；测试覆盖时间/容量拒绝、重放幂等和写入失败回滚。默认按理想最短路径同日达标，并为 R/P 分别预留；调用者也可传入不同预计达标日。失败与目标变化后的真实重算由 T02 结算联调。
- 正式 task service 已在签发事务内按每个词条时区调用 `getScheduleDecision`，仅签发 DB chooser 选中的候选；EMPTY 返回 chooser 的具体原因与可计算的 next availability。候选必须在实际派题本地日有有效容量预约；逾期轴保留原 `due_at`，但要有今日预约才能派发。材料待生成、冷却未知 ETA、训练窗恢复时间和不支持的后续题档均有明确结果。

## 验证

- 容量不足 EMPTY：未来 41 个本地日内，存在可执行候选且容量可用（含该候选有效预约）时，返回其最早可执行时间；缺少可靠未来证据时仍返回 `null`。
- `npx jest --runInBand test/new-algorithm-scheduler.jest.test.cjs test/new-algorithm-task-service.jest.test.cjs`：27/27 通过。
- `npx jest --runInBand`：15 suites / 169 tests 通过。
- `git diff --check`：通过。
- `npx tsc --noEmit`：仍只有已知的两个非本次错误：`app/score-history/page.tsx:57`、`lib/manual-test-fixtures.ts:183`。

## 未完成，不得标 DONE

- task service 的 DB chooser 接线只签发当前服务支持的连接/choice 阶段；cued/free/FLUENCY 的签发仍由后续生命周期节点实现。冷却的 7-tick ETA 不可预测时返回 null；训练窗口关闭时可计算下一窗口开始时间；容量短缺仅在未来 41 天内已有可执行候选和容量证据时计算，否则返回 null。多时区以各时区独立决策后按稳定调度优先级择一。
- DB 决策已保留材料失败/待生成状态供同档候选切换；材料补充作业恢复和多进程并发签发验证仍待实现。
- 新词 helper 默认用理想最短路径推定两轴同日达标；传入不同预测日仍由调用者负责。实际练习用时不在规范定义中，当前仅按 O1 的冷却下界检验窗口；非默认目标/实际结果导致的预约重算需与 T02 结算联调。
- 已验证预约写入异常会回滚旧预约取消；仍需补齐日容量/时间窗完整边界、目标变更/复习失败、材料故障恢复及 EMPTY next availability 的临时库矩阵；V05 人工验收仍未进行。

V05 人工双轴验收和正式端到端派题都尚无 PASS 证据。
