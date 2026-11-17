# 邮箱登录与业务数据范围

## 用户记录

- 讨论接入简单的邮箱登录，采用邮箱验证码。
- 邮件验证码通过 QQ 邮箱 SMTP 服务发送。
- 接口需要鉴权，并接入 `learnerId` 数据范围。
- 账号身份使用 `userId`；`userId` 与 `learnerId` 的映射由服务端维护，业务接口不得信任客户端传入的身份标识作为授权依据。
- 当前业务数据视为用户私有数据，没有共享数据。

## 调查记录

- 当前 `LearningStateRepository` 仅提供全量 `load()` / `save()`，没有按 `userId` 或 `learnerId` 查询的接口。
- SQLite 部分实体表含 `learner_id`，但当前仓储仍整体加载状态，不能据此实现用户隔离。
- 需要为账号、登录会话和学习者关联建立服务端数据访问路径，并改造业务接口及 repository。
- 所有现有学习数据 API 都属于登录保护范围，包括 learner、plan、assessments、tasks、materials、goals、knowledge 及其相关操作接口。
