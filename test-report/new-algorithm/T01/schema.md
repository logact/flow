# T01 新库与夹具证据

- 日期：2026-11-07；Node 22.20.0；SQLite 由仓库 `better-sqlite3` 提供。仅使用 `test/new-algorithm-fixture.cjs` 创建的系统临时库，关闭后删除；未打开或迁移 `flow.db`。
- 命令：`node test/run-new-algorithm-db-tests.cjs`，退出码 0，13/13（T01 schema 4 项，T02 结算 7 项，T03 导入 2 项）。runner 在系统临时目录编译 schema/结算模块，不使用正式应用数据库。
- 输入：空临时库、重复初始化、含一张 `words` 表的旧库、错误 schema 版本、同一实例/作答/事件 ID、错误材料版本、注入抛错事务、一次 ENCODE 原子结算及重放。
- 期望与实际：schema 二次初始化幂等；初始双轴分数 0、H 各 3600000ms、observation 0、所有时间/tick 锚 null、全局 tick 0；旧库及错误版本拒绝且不变；材料版本外键、单活跃实例、单冻结作答、事件 dedupe key 均拒绝重复；失败事务没有半笔分数、H、锚、tick 或事件。
- DB 前后快照：回滚测试前后 `score_r=0, half_life_r=3600000, last_ts_any=null, global_tick=0, events=0`。结算测试前双轴 0/H 3600000/锚 null/tick 0；后 R=5、H_R=5400000、observation_R=0、R/词级时间锚为测试时钟、词级 tick=1、全局 tick=1；P 分数/H/轴锚不变。重放后这些值不再变化，completed 事件仅 1 条。
- schema dump：`schema.sql`，从空内存库的 `sqlite_master` 生成。范围为 `meta`、`words`、`materials`、`task_instances`、`attempts`、`events`，含材料版本、冻结 response/计时/曝光 JSON、终态和事件去重键。共用夹具提供可控时钟、固定 ID、材料、脚本判分响应、并发栅栏。
- 限制：这是独立新库工厂；T03/T04 尚未接入应用。T02 结算测试只覆盖 ENCODE 一条路径，不构成 T02 完成或 V01 端到端验收。
