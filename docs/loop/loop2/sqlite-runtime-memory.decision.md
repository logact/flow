# SQLite 仓储与运行时内存仓储决策

## 决策

- 当前应用运行时使用 `InMemoryAppRepository` 和 `emptyLearningState()`，不启用 SQLite 仓储。
- SQLite 仓储、迁移及其测试保留在代码库中，作为尚未启用的候选实现；启用前须另行评审并完成集成验证。
- 学习状态仅保存在服务进程内存中。服务进程重启后，状态重置并重新初始化演示数据，不承诺跨进程重启持久化。
- 磁盘上可能已有的 `.flow/flow.sqlite` 文件不读取、不迁移、不删除。

## 调查依据

- `lib/server/runtime.ts` 最初使用 `InMemoryAppRepository`；提交 `055518f`（2026-11-16 08:46 +08:00，标题“feat: 添加 SQLite repository（待审核）”）将运行时切换为 `SqliteLearningStateRepository`。
- SQLite 仓储实现和 `test/sqlite-repository.jest.test.ts` 中的 SQLite `:memory:` 覆盖继续保留；它们不代表应用运行时已获准启用 SQLite。

## 实施范围

- **Runtime**：恢复运行时仓储为 `InMemoryAppRepository`，移除启动时 SQLite 路径、目录和连接初始化；初始化失败时重建空内存仓储。
- **Documentation**：将此前关于 SQLite 持久化的运行时说明标注为历史实现，并链接本决策。
- **Data**：不处理、不删除已有 SQLite 文件。

## 验证

- TypeScript 类型检查通过。
- 静态检查确认 `lib/server/runtime.ts` 不再引用 SQLite 数据库路径、连接或仓储。
- 本次未运行测试套件。SQLite 仓储测试仍独立保留，后续启用前应执行对应测试及运行时集成验证。
