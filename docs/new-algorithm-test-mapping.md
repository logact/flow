# 新算法测试设计 v0.2

权威规则：[algorithm.md](./algorithm.md)。旧 DAG 与任务流测试曾锁定 q、checkpoint、INTEGRATE、毕业和失败保分等旧规则，现已从 `test/` 移除；T00 历史日志保留为迁移依据，不计入新版通过率。通用 `llm.test.cjs` 保留。

## 当前可执行层

| 命令 | 覆盖 | 结果与边界 |
|---|---|---|
| `node test/run-new-algorithm-score-tests.cjs` | 唯一分档、提取分表、R/P FLUENCY 公式及 D2 增强 | 5/5；纯函数 |
| `node test/run-new-algorithm-db-tests.cjs` | 新库约束、结算幂等、双轴分数回写、反馈增强、回滚、导入 | 13/13；独立临时库 |
| `node test/run-new-algorithm-scenarios.cjs` | 生词到 Fluency 的升级、失败降级、有效不变分、无效/不确定分数投影 | 21/21；逐场景实际分数见[报告](../test-report/new-algorithm/scenarios.md) |
| `node test/run-llm-tests.cjs` | 通用 provider 配置/超时/schema | 不代表新版材料或判分验收 |

## 下一层：新版调度器落地后运行

下表是**待实现断言**，不是当前 PASS。各场景都需在临时库中插入词和同档合格材料，调用正式新版调度入口并检查实际 `axis/type/stage/material_id`，结算后再次调度。可控 clock/tick 避免真实等待。

| ID | 初态与动作 | 期望分数变化 | 期望实际派题或 EMPTY |
|---|---|---|---|
| S01 | R=0，确认 ENCODE | 0→5 | 冷却前等待；冷却后 R choice |
| S02 | R=5/20/40 连续正确 | 5→20→40→60 | 各次冷却后依次 cued/free/FLUENCY |
| S03 | P=0 到 60 连续正确 | 0→5→20→40→60 | P 各档独立，不改 R |
| S04 | R FLUENCY 80，200 wpm 双题正确 | 80→73.33333333333333 | 下次仍 R FLUENCY；可下降 |
| S05 | R FLUENCY 80，目标错 | 80→40 | 下次 R free，不改变 P |
| S06 | P FLUENCY 80，24.9 wpm 双项正确 | 80→40 | 下次 P free |
| S07 | P FLUENCY 整体未过或判分不确定 | 有效不变 80；不确定无结算 | 有效不变走冷却；不确定保留作答待重试 |
| S08 | 两轴都有锚，另一轴先完成 | 只改目标轴 | 共享冷却更新，另一轴 F/H/observation 不变 |
| S09 | F≥target 且 L<0.2 | 分数派发前不变 | 急救仍按当前 F 派 FLUENCY，不提前降档 |
| S10 | 当前档材料失败，下一档材料存在 | 不变 | 返回材料原因或重新比较其他候选，不降档 |

独立材料/API/UI 验收继续按 T03–T15、V01–V08 的 DAG 执行。测试报告必须列场景、期望与实际分数、任务类型/档位、DB/事件变化；缺正式入口或材料时标未执行，不用纯函数投影替代签发证据。
