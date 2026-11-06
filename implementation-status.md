# Implementation audit

审计时间：2026-11-06。此次审计后停止新增实现。`PARTIAL` 表示代码已有提交，但至少一项验收仍缺实际验证或功能支撑；未以 TypeScript 编译代替 UI/行为验收。

## T01–T16 状态

| ID | 状态 | 代码 / 提交 | 验证与未完成项 |
|---|---|---|---|
| T01 | DONE | `lib/tasks.ts`；`cf7e67b` | 定义抽象任务、实例、结果、证据及 `EMPTY` 原因；后续全量 TypeScript/build 通过。 |
| T02 | PARTIAL | `app/task-preview/page.tsx`, `app/task-preview/page.module.css`；`6937945` | 移除旧平滑计分和教学加分文案，补交互阶段标记；移动/桌面原型没有实际浏览器视觉验收。 |
| T03 | DONE | `lib/db.ts`；`88c9bae` | 增加先验、双轴观察/认证/速度/综合/重学及旧分数/词频来源字段；迁移按列存在检查。TypeScript 检查通过。 |
| T04 | DONE | `lib/targets.ts`, `lib/goals.ts`, `lib/config.ts`, `lib/db.ts`；`7483809` | 目标映射为 `60 + 40 × 速度位置`，校验速度边界，词频不抬目标，先验不写成绩。TypeScript 检查通过。 |
| T05 | DONE | `lib/scheduler.ts`；`e8684d8`, `f4a9462` | 按实例关卡/证据回写；失败保分撤销认证，目标词失败置待重学，教学不计分，轴间状态和游标独立。T14 覆盖关卡晋级、失败保分与重学；TypeScript 检查通过。 |
| T06 | DONE | `lib/db.ts`；`a898737` | 只从结构完整的独立旧事件恢复分数；旧分数保留到 `legacy_score_*`，不恢复速度认证/综合/毕业；一次性迁移标记。T14 覆盖迁移幂等。 |
| T07 | DONE | `lib/tasks.ts`；`f2a4bf8` | 注册 P/R 的四类任务和资格筛选，低分两轴都有 RETRIEVE；T14 首遇路由测试及 TypeScript 检查通过。 |
| T08 | PARTIAL | `lib/material.ts`, `lib/mfi.ts`, `components/task-cards.tsx`；`d3704e1` | 有材料长度、语言覆盖、目标词归属、连续测速和明确材料缺口能力；但调度入口没有提供主题词/主题元数据，实际派题无法验证主题匹配。 |
| T09 | PARTIAL | `lib/scheduler.ts`, `lib/config.ts`；`ab6064d`, `d6993e0`, `8015b7d` | 已实现优先级、双轴长期记忆、共享冷却、R 流利答案键筛选、材料缺口和 P 综合。R 综合因缺少服务端可核验的多目标整段理解答案而被跳过；没有完成 R 综合派题。 |
| T10 | DONE | `app/api/task/route.ts`, `app/api/task/result/route.ts`, `app/api/task/service.ts`, `lib/db.ts`；`f5033d5`, `d7adf9d` | 服务端签发/恢复实例、核对词项与证据、重复提交幂等、事务回写，并隐藏 R 独立任务释义。T15 覆盖恢复、重试和重复提交；TypeScript/build 通过。 |
| T11 | PARTIAL | `components/task-renderers.tsx`；`2ec1e15`, `4186340` | 四类 renderer、独立性/提示状态、连续读写证据与键盘提交已实现；T15 只检查源代码契约，没有实际浏览器交互验收。 |
| T12 | PARTIAL | `app/page.tsx`, `app/page.module.css`；`9fa33bb` | 单卡任务流、实例恢复、提交锁、反馈后切换、网络失败保留输入、未提交滑动不切题、EMPTY 状态与调试折叠已实现；移动/桌面行为没有实际浏览器验收。 |
| T13 | PARTIAL | `app/page.tsx`, `app/page.module.css`；`43d42b3` | 主流程已接入正式 renderer 与服务端 API；完整 UI 学习旅程只通过 service 与源码契约测试，未在浏览器里完成验收。 |
| T14 | DONE | `test/task-implementation-dag.test.cjs`, `test/run-task-dag-tests.cjs`；`80b086d` | 固定时间/迁移验收 8 项通过，覆盖先验路由、关卡、冷却、急救/重学、P 综合、目标、毕业和迁移。 |
| T15 | PARTIAL | `test/task-flow-journey.test.cjs`, `test/run-task-flow-tests.cjs`；`5d74b54`, `06a8264` | 6 项 service/源码契约测试通过，覆盖导入、恢复、失败重试、重复提交、复核、触屏/键盘契约和长文 CSS；没有真实手机/桌面浏览器旅程验收。 |
| T16 | PARTIAL | `lib/task-analytics.ts`, `app/api/task/analytics/route.ts`, `app/api/task/service.ts`, `lib/db.ts`, `app/page.tsx`；`06a8264` | 可聚合通过率、复核、材料缺口、退出和速度分布。没有显式跳过/延期动作，`skip_count` 固定为 0 且 `instrumentation.skips=false`，因此跳过率验收未完成。 |

## 当前工作树

审计开始时，除本审计文件外，唯一未提交改动是 `next-env.d.ts`：`npm run build` 将两个引用从 `.next/dev/types/` 改为 `.next/types/`。这是构建生成的文件变化，不属于上述实现提交。`git diff --check` 通过。审计文件本身按请求新增，未提交。

## 已有验证结果

- `npx tsc --noEmit --incremental false`：通过，退出码 0。
- `node test/run-task-dag-tests.cjs`：8/8 通过。
- `node test/run-task-flow-tests.cjs`：6/6 通过。
- `npm run build`：通过；Next.js 生成 `/api/task/analytics` 等路由。
- 当前没有失败的测试。开发期间 T12 曾出现 `app/page.tsx` 第 107 行的临时类型错误，已修复；最终 TypeScript 检查和构建通过。早期子 agent 发生过传输错误，没有留下代码或测试失败。

## 阻碍整体交付的关键问题

1. **R 轴综合任务未交付。** 调度器为避免不可核验的结果而跳过 R `INTEGRATE`；当前只有 P 综合任务可派。需要用同一段服务端持有的材料、覆盖所有目标词的逐词检查及答案键补齐 R 综合证据，再接入 T09 调度和验收。
2. **跳过率未启用。** 页面没有显式跳过/延期操作；未提交的上滑会保留当前任务。T16 只能报告无跳过事件，不能提供真实跳过率。
3. **主题匹配没有接入材料来源。** 校验函数支持主题词，但当前派题没有主题元数据/词表，因此实际候选尚未按主题条件过滤。

## 下一步最小独立工作包

**补齐 R 多目标 MFI 综合任务**：用现有 `sliceMfiDetailed` 的多目标检查，挑选同一书源中同时覆盖全部目标词的连续片段；服务端保存整段理解选项答案键及逐词释义检查；仅在材料和答案键完整时签发 R `INTEGRATE`。随后补一条确定性 scheduler/API 测试。该工作包完成后，再决定是否新增显式跳过/延期动作及其调度语义。
