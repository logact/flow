# 旧测试迁移清单 v0.1

以下按现有 `test/*.test.cjs` 用例逐类处理。保留基础设施与仍符合规范的断言；替换旧产品语义时先加新版正反断言。旧 runner 当前通过只证明旧实现一致。

| 测试文件/现有用例 | 处理 | 新规范断言与负责节点 |
|---|---|---|
| `task-implementation-dag`: q 首派、checkpoint、急救复核/重学、INTEGRATE、目标反推、毕业、旧成绩迁移 | 替换 | F 唯一定档、急救不改档、直接目标、无毕业；T02/T12/T15 |
| `task-implementation-dag`: 轴级保留与共享冷却 | 修改 | `R=L`、7 tick/20 分钟、词级独立锚及严格急救线；T02/T12 |
| `gloss-flow`: 未确认 AI 释义、同义接受、服务失败 | 保留并扩展 | 词义版本失效、冻结答案与判分重试；T03/T04/T06 |
| `task-flow-journey`: verified/checkpoint 旅程 | 替换 | 正式导入→ENCODE→choice→反馈→调度；V01/V02 |
| `task-flow-journey`: 上滑、刷新、响应锁、键盘/滚动源码检查 | 修改为浏览器行为验收 | 未提交上滑忽略，真实触控/焦点/刷新与网络状态；V06/V08 |
| `p-expression-flow`: P FLUENCY 质量、29词、失败关闭 | 修改 | 目标/整体两检查、低于30词继续、计时与保留作答重试；T10/T11/V04 |
| `p-expression-flow`: P INTEGRATE 两项 | 替换 | 正式路径永不签发 INTEGRATE；T15 |
| `r-comprehension-flow`: R FLUENCY 与并发 GET | 修改 | 100词/5次、目标/整体双题、回看、速度直写、答案私有；T08/T09/V03 |
| `r-comprehension-flow`: R INTEGRATE、材料失败降档 | 替换 | 同档重试与其他候选，材料缺口 EMPTY；T12/T15 |
| `topic-flow`: 书籍主题识别 | 保留辅助能力 | 无书源也能生产合格 R 材料；T08 |
| `task-analytics`: skip/exit 幂等与统计 | 修改 | 有效不变分计 attempts、invalid 排除、互斥终态；T13/T14 |
| `task-analytics`: 旧实例 CHECK 迁移 | 替换 | 新库 schema 初始化与约束，不迁移旧成绩；T01 |
| `llm`: 配置、超时、schema、脱敏 | 保留并扩展 | uncertain/双检查/冻结依据；T06/T08/T10 |

新增 `new-algorithm-score.test.cjs` 是新版分档与直接计分的首批断言；尚未接入正式路由，不能作为 T02/V01 完成证据。
