# 新算法测试设计 v0.3（待 T00 冻结）

权威规则：[algorithm.md](./algorithm.md)。旧 DAG 与任务流测试曾锁定 q、checkpoint、INTEGRATE、毕业和失败保分等旧规则，现已从 `test/` 移除；T00 历史日志保留为迁移依据，不计入新版通过率。通用 `llm.test.cjs` 保留。下列旧版计分/记忆测试仍可运行，但连接、H/L 与复习排期语义已过期，不作为现行规范的 PASS。

## 当前可执行层

| 命令 | 覆盖 | 结果与边界 |
|---|---|---|
| `node test/run-new-algorithm-score-tests.cjs` | 唯一分档、提取分表、R/P FLUENCY 公式及 D2 增强 | 5/5；纯函数 |
| `node test/run-new-algorithm-db-tests.cjs` | 新库约束、结算幂等、双轴分数回写、反馈增强、回滚、导入 | 13/13；独立临时库 |
| `npm run test:new-algorithm-scenarios` | Jest：生词到 Fluency 的连续升级、失败降级、有效不变分、无效/不确定分数投影 | 14/14 个场景、23 次转移；逐场景实际分数见[报告](../test-report/new-algorithm/scenarios.md) |
| `npm run test:new-algorithm-memory` | Jest：L 随时间衰减、D2 曝光增强 H、共享冷却、普通复习和急救候选门槛 | 8 个轨迹场景及 1 个边界测试；逐步计算见[报告](../test-report/new-algorithm/memory.md)。纯候选判断，不代表正式派题 |
| `node test/run-llm-tests.cjs` | 通用 provider 配置/超时/schema | 不代表新版材料或判分验收 |

## 下一层：独立轴排期的待实现断言

更完整的 53 条讨论场景见[场景讨论稿](./new-algorithm-scenarios-draft.md)；本表只保留调度主线，不代表已经执行。

下表是**待实现断言**，不是当前 PASS。各场景需在临时库调用正式新版调度入口并检查实际 `axis/type/stage/material_id`、两轴排期与容量，结算后再次调度。可控 clock/tick 避免真实等待。

| ID | 初态与动作 | 期望分数变化 | 期望实际派题或 EMPTY |
|---|---|---|---|
| S01 | 未引入词确认一次连接 | R/P 各 `max(原分,5)` | 只签发一次 `axis=both`，只加一个 tick；两轴学习 `due_at_a` 为当天 |
| S02 | R 三档成功，P 尚未完成 | R 5→20→40→60；P 不变 | R/P 各按自身分数定档，共享冷却 |
| S03 | R 达标 FLUENCY 比 P 早一天 | 只更新 R | R `due_at_R=R达标日+1`；P 保持当天学习 `due_at_P`，R 复习可先开始 |
| S04 | P 隔天达标 FLUENCY | 只更新 P | P `due_at_P=P达标日+1`；R 已确定复习日期不变；两轴未来预约落在各自第 1/4/11/41 天 |
| S05 | R 到期复习通过，P 仍学习或未到期 | 只更新 R | R 独立升 1→3→7→30；P `review_level_P/due_at_P` 不变 |
| S06 | P 复习有效失败并降分 | 只更新 P | P 按 1→1、3→1、7→3、30→7 退级，`due_at_P=失败当天` 补练；R 排期不变 |
| S07 | R 复习有效未通过但不降分；P 判分不确定 | R 实际分数照规范；P 不结算 | R 不升级，按退级间隔重排；P 保留原 `due_at_P` 供重试 |
| S08 | R 完成自己的 30 天复习，P 尚未毕业 | 只更新 R | `graduated_R=true, due_at_R=∞`；词未毕业，P 继续派题 |
| S09 | P 也完成自己的 30 天复习 | 只更新 P | `graduated_P=true, due_at_P=∞, graduated=true`；词不再派题 |
| S10 | R 复习和同词 P 学习同时到期 | 不变 | 先比较 R 复习；仍需共享 7 tick 或 20 分钟冷却，过期先于新词 |
| S11 | 逐日容量刚好、不足、两轴日期错开 | 随真实作答变化 | 当天按新词 9 题预算，未来按轴条件预约；结算只重排目标轴预约并重算总容量；短缺停止引新词 |
| S12 | 当前档材料失败，下一档材料存在 | 不变 | 返回材料原因或重新比较其他候选，不降档 |

独立材料/API/UI 验收继续按 T03–T15、V01–V08 的 DAG 执行。测试报告必须列场景、期望与实际分数、任务类型/档位、DB/事件变化；缺正式入口或材料时标未执行，不用纯函数投影替代签发证据。

## 待新增：词汇量初分与跳档（当前未通过）

| 场景 | 输入 | 首题及容量断言 |
|---|---|---|
| I01 | `rank≤0.5V` | R60/P40；R FLUENCY、P free；最少 3 题；无通过证据 |
| I02 | `0.5V<rank≤V` | R40/P20；R free、P cued；最少 5 题 |
| I03 | `V<rank≤1.5V` | R20/P5；R cued、P choice；最少 7 题 |
| I04 | `rank>1.5V` 或 V/rank 缺失、不可比 | R0/P0；一次词级连接后两轴 5；最少 9 题 |
| I05 | 非零估计初分、实测失败、词汇量变化 | 不补连接；按实测结果降档；已开始词不重置分数或排期 |

边界分别测试 `0.5V`、`V`、`1.5V` 两侧；原始频率不得冒充排名。上述场景须经过正式导入和派题服务，不能只验证纯映射函数。
