# 新算法场景与分数变化报告

范围：新版纯函数的“当前分数→应做档位→结算分数→下一应做档位”。下一档是算法要求，尚未证明正式调度器签发了该任务。所有数值使用未舍入值断言。

| ID | 轴 | 当前分数 | 当前档位 | 场景 | 期望分数 | 实际分数 | 下一档 | 结果 |
|---|---|---:|---|---|---:|---:|---|---|
| R01 | R | 0 | encode | ENCODE 确认 | 5 | 5 | choice | PASS |
| R02 | R | 5 | choice | choice 正确 | 20 | 20 | cued | PASS |
| R03 | R | 20 | cued | cued 正确 | 40 | 40 | free | PASS |
| R04 | R | 40 | free | free 正确 | 60 | 60 | fluency | PASS |
| R05 | R | 80 | fluency | FLUENCY 双题正确 200 wpm | 73.33333333333333 | 73.33333333333333 | fluency | PASS |
| R06 | R | 80 | fluency | FLUENCY 双题正确 149 wpm | 40 | 40 | free | PASS |
| R07 | R | 80 | fluency | FLUENCY 目标词错误 300 wpm | 40 | 40 | free | PASS |
| R08 | R | 80 | fluency | FLUENCY 仅整段理解错误 | 80 | 80 | fluency | PASS |
| R09 | R | 40 | free | free 错误 | 20 | 20 | cued | PASS |
| R10 | R | 20 | cued | cued 错误 | 5 | 5 | choice | PASS |
| P01 | P | 0 | encode | ENCODE 确认 | 5 | 5 | choice | PASS |
| P02 | P | 5 | choice | choice 正确 | 20 | 20 | cued | PASS |
| P03 | P | 20 | cued | cued 正确 | 40 | 40 | free | PASS |
| P04 | P | 40 | free | free 正确 | 60 | 60 | fluency | PASS |
| P05 | P | 80 | fluency | FLUENCY 双项正确 42.5 wpm | 80 | 80 | fluency | PASS |
| P06 | P | 80 | fluency | FLUENCY 双项正确 24.9 wpm | 40 | 40 | free | PASS |
| P07 | P | 80 | fluency | FLUENCY 目标表达错误 60 wpm | 40 | 40 | free | PASS |
| P08 | P | 80 | fluency | FLUENCY 仅整体表达错误 | 80 | 80 | fluency | PASS |
| P09 | P | 80 | fluency | FLUENCY 计时无效 | 80 | 80 | fluency | PASS |
| P10 | P | 80 | fluency | FLUENCY 判分不确定 | 80 | 80 | fluency | PASS |
| P11 | P | 40 | free | free 错误 | 20 | 20 | cued | PASS |

已执行 21/21 个场景。

未覆盖：词/轴调度优先级、冷却与急救、正式材料签发、API、UI。待新版调度器接入后增加“实际签发 task.type/stage/material_id”断言；本报告不将下一档投影冒充已签发任务。
