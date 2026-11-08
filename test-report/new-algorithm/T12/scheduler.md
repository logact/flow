# T12 调度与容量（IN_PROGRESS）

## 本次工作树实现

- review → learning → new 的稳定优先顺序；旧候选按本地到期日、word ID、R→P 排序。新词比较先按可比词频来源分组（当前书优先），再按组内词频、归一化目标缺口和 word ID；缺失频率排最后。
- `chooseScheduleCandidate` 汇总已提供的候选、冷却、容量和 scope 输入，返回候选或 `today_complete`、`capacity_insufficient`、`cooldown_wait`、`material_pending`、`material_failed`、`scope_empty` 等 EMPTY 原因。冷却中的候选不阻塞其他候选。
- `loadScheduleCandidates` 从隔离 schema 读取 due 轴/新词预约，按各词 IANA 时区转换日期；毕业轴不派发；材料需为当前 `meaning_version` 下未使用的 ready 版本。
- 每日容量投影覆盖今天至第 41 天，分列 completed、determined、conditional、introduction；轴级预约可以事务式重算并保持另一轴数据。新词准入事务校验当前任务量、注入的剩余时长、材料和 42 日投影，并以稳定 ID 写入 introduction 与 R/P 条件预约。预计达标日期由调用者提供。

## 验证

- `npx jest --runInBand test/new-algorithm-scheduler.jest.test.cjs`：12/12 通过。
- `npx jest --runInBand`：15 suites / 161 tests 通过。
- `git diff --check`：通过。
- `npx tsc --noEmit`：仍只有已知的两个非本次错误：`app/score-history/page.tsx:57`、`lib/manual-test-fixtures.ts:183`。

## 未完成，不得标 DONE

- 选择器尚未接正式 API/派题；数据库读取尚未把 tick、容量、材料状态和 EMPTY 的 `next_available_at` 统一形成一个可调用决策，也没有覆盖当前容量限制下的已到期任务选择。
- loader 过滤了不可用材料；same-stage 备选虽可由排序器选择，但未从真实 DB 材料状态完整保留候选与原因。
- 新词 helper 接收预计 R/P 达标日期和时间可用量，尚未依据目标、当前轴状态、训练窗口及最短冷却路径计算这些值；非默认目标/实际结果导致的预约重算需与 T02 结算联调。
- 需补齐日容量/时间窗边界、跨时区/夏令时、失败与目标变化、transaction rollback、材料故障候选切换及 EMPTY next availability 的临时库矩阵；V05 人工验收仍未进行。

V05 人工双轴验收和正式端到端派题都尚无 PASS 证据。
