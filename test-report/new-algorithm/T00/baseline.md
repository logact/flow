# T00 基线证据

- 日期：2026-11-06；源码 HEAD `577522c0a82f2cbdd04c5a89aaccbcdca89a4634`；包管理器：仓库同时有 bun/npm/pnpm lock，当前验证使用已安装的 `node_modules` 与 Node runner，未改依赖。
- 输入：当前 `docs/algorithm.md`、`docs/task-implementation-new-algorithm.md`、既有测试源码。
- 期望：契约、状态转移、D1–D8 未决台账、旧测试映射、24 节点依赖与可执行命令。
- 实际：`docs/new-algorithm-contracts.md`、`docs/new-algorithm-decisions.md`、`docs/new-algorithm-test-mapping.md`、`docs/new-algorithm-execution.json`。D1–D8 已按用户授权记录原型值；正式体验仍待 V 节点验收。
- `node test/run-task-dag-tests.cjs`：退出 0，8/8；测试标题仍含 q、INTEGRATE、毕业，不能证明新版业务。
- `node test/run-task-flow-tests.cjs`：退出 0；旧业务断言，日志位于 `/tmp/flow-old-flow-test.log`（临时，不作为持久证据）。
- `node test/run-llm-tests.cjs`：退出 0；日志位于 `/tmp/flow-old-llm-test.log`（临时）。
- `npx tsc --noEmit`：退出 1；既有 `app/score-history/page.tsx:57` 的 flatMap/null 推断错误与 `lib/manual-test-fixtures.ts:183` 的不可能 `baseline` 分支。未将其记为新版回归。
- DB 前后：本节点未改数据库，也未操作用户 `flow.db`。事件：无。浏览器：未验收。
