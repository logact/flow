# SQLite Repository 测试计划

## 背景与范围

SQLite repository 当前作为候选实现保留，运行时尚未启用。此计划针对 `SqliteLearningStateRepository`、SQLite schema/迁移及其细粒度 repository 接口设计验证；完成测试不代表批准切换运行时。

实现位置：`lib/server/sqlite/repository.ts`  
现有测试：`test/sqlite-repository.jest.test.ts`

## 目标

- 验证状态读写、持久化、事务回滚和 revision 并发控制。
- 验证关联表、复合键、外键及有序数据的读写一致性。
- 覆盖 repository 对外提供的材料、目标材料、知识点选择和任务上下文接口。
- 验证 schema 初始化和迁移约束。

## 测试计划

### P0：状态读写与事务

- 新数据库加载完整空状态，revision 为 `0`。
- 保存完整状态后，加载数据与保存内容一致；覆盖新增、更新和删除。
- 文件数据库关闭并重开后，状态与 revision 保持一致。
- 保存遇到外键或唯一约束错误时整笔事务回滚，revision 不变。
- 无效 JSON 数据加载时产生明确错误。

### P0：revision 并发控制

- 使用过期 revision 保存时抛出 `ConcurrencyConflictError`。
- 冲突后数据库状态和 revision 保持不变。
- 两次保存使用相同 revision 时，仅第一次成功。

### P0：关联与顺序

- study plan 任务、词汇测评任务、分析条目及 occurrence 的顺序可正确保存和加载。
- 重排任务顺序后位置正确，且不触发唯一 position 约束。
- 删除父记录时，关联行按外键规则正确处理。

### P1：材料接口

- 覆盖 `saveMaterial`、`saveMaterialAnalysis`、`saveMaterialWithAnalysis` 的新增和更新。
- material 不存在时保存分析应失败且不改变状态。
- pending 分析可在同一 ID 下完成为 analyzed。
- analyzed 记录不允许非法修改；失败时状态和 revision 不变。

### P1：目标材料接口

- `saveGoalMaterial` 写入 goal、材料关联、knowledge points、候选项和来源。
- `loadGoalScope` 返回指定 goal 的关联数据。
- 重复保存相同复合键时更新而不产生重复记录。

### P1：知识点选择接口

- `loadSelectionContext` 返回目标、学习者、候选项、分类和学习者知识点。
- goal 或 learner 不存在时返回 `null`。
- `saveKnowledgePointSelection` 更新候选项并 upsert 新关联；聚合状态和 revision 一致。

### P1：任务生成上下文

- `loadTaskGenerationContext` 仅返回指定目标和知识点的来源材料及学习者词汇。
- goal、候选项或知识点缺失时返回 `null`。
- 学习者缺失时词汇字段按接口约定返回 `null`。

### P2：迁移与 schema

- 验证新库初始化及重复初始化行为。
- 检查主键、复合唯一键、外键、CHECK 约束和查询索引。
- 覆盖负 revision、负 position、重复关联及缺失外键目标等非法数据。

## 测试约定

- 大多数用例使用独立 `:memory:` 数据库；持久化用例使用临时目录中的文件数据库。
- 使用真实 `better-sqlite3` 连接，不 mock SQLite 驱动。
- 每个用例关闭连接；临时文件在用例结束后清理。
- save 类用例同时检查加载状态和 revision；关系顺序必要时直接检查关系表。
- 优先补充现有测试缺口，避免重复覆盖已有用例。

## 执行顺序与验收

先完成 P0，再完成 P1，最后完成 P2。验收要求：计划中的测试均通过，失败路径验证数据库回滚和 revision 不变；独立执行命令如下：

```bash
npm test -- test/sqlite-repository.jest.test.ts
```

## 现有覆盖概况

当前测试已覆盖文件重开和 revision 冲突、pending 到 analyzed、外键失败回滚、部分索引和外键 schema、负 revision/position、部分细粒度接口以及测评任务重排。实施时应对照本计划补足未覆盖场景。
