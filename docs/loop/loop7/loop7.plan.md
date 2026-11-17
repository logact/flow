# Loop7 实施计划

## 目标

实现邮箱验证码登录，并让业务接口按登录账号关联的 `learnerId` 隔离数据。账号身份使用 `userId`，学习数据范围使用服务端解析出的 `learnerId`。

## 场景

### 场景 1：邮箱验证码登录与会话鉴权

#### include decision

- [邮箱登录与业务数据鉴权决策](decision/email-login-and-data-authorization.decision.md)：QQ 邮箱 SMTP、`userId` 账号身份、服务端会话，以及用户私有数据鉴权原则。

#### description

用户通过邮箱获取一次性验证码并完成登录。首次验证成功时创建账号和关联学习者；后续登录恢复同一账号。会话由服务端签发、验证和撤销。匿名访问仅限验证码登录所需接口；其他业务 API 在没有有效会话时拒绝请求。

#### impl plan

**domain**

- 定义账号、邮箱验证码挑战、会话及 `userId` 到 `learnerId` 的身份关联模型。
- 明确验证码有效期、一次性消费、重发间隔、错误尝试上限，以及会话有效期和撤销规则。

**service**

- 使用 QQ 邮箱 SMTP 配置发送验证码；凭证通过服务端环境变量提供。
- 提供请求验证码、验证登录、读取当前身份和退出登录的服务端能力。
- 验证成功后创建或查找 `userId`，并保证其关联的 `learnerId` 稳定且唯一。
- 使用安全 Cookie 保存不可预测的会话凭证；服务端校验会话并解析当前 `userId` / `learnerId`。
- 对验证码发送和尝试进行限流；验证码只保存安全表示，成功消费后不可复用。
- 定义并实现演示数据的归属迁移策略，确保新用户不会看到或修改其他用户数据。

**UI**

- 增加邮箱输入、发送验证码、验证码输入、登录反馈及退出登录交互。
- 登录成功后返回用户原本访问的页面；未登录访问受保护页面时跳转登录。
- UI 提供状态反馈，不参与身份判定或决定数据访问范围。

#### 验收

- 正确验证码可创建或恢复账号及其学习者；错误、过期、已使用验证码不能登录。
- 重发间隔、尝试次数限制有效；SMTP 凭证不进入客户端。
- 会话 Cookie 具备 `HttpOnly`、`Secure`（生产环境）和合适的 `SameSite` 属性；退出后会话不能继续使用。
- 未登录访问业务 API 返回未认证响应；匿名登录接口可用。
- 演示数据归属符合迁移策略，用户间不可见、不可修改。

### 场景 2：业务接口接入 `learnerId`

#### include decision

- [邮箱登录与业务数据鉴权决策](decision/email-login-and-data-authorization.decision.md)：所有业务学习数据私有，所有现有学习数据 API 均需鉴权及归属校验。

#### description

将当前全量状态读写改为按当前会话对应的 `learnerId` 访问。接口从服务端会话取得身份，不信任请求体、查询参数或路径中传入的 `userId` / `learnerId`。通过资源 ID 读写数据时，同时验证该资源及其关联资源属于当前学习者。

覆盖接口：

- `GET/PUT /api/learner`、`GET /api/plan/today`
- `GET/POST /api/assessments`、`POST /api/assessments/[id]/attempts`、`POST /api/assessments/[id]/finish`
- `POST /api/tasks/[id]/attempt`
- `GET/POST /api/materials`、`GET/PATCH /api/materials/[id]`、`POST /api/materials/[id]/analysis`、`POST /api/materials/[id]/analysis/resolve`
- `GET/POST /api/goals`、`GET /api/goals/[id]`、`POST /api/goals/[id]/status`、`POST /api/goals/[id]/selection`、`GET/POST /api/goals/create`
- `GET /api/knowledge`、`GET /api/knowledge/[id]`、`GET /api/knowledge/selection`、`POST /api/knowledge/[id]/meaning`、`POST /api/knowledge/[id]/pronunciation`

#### impl plan

**domain**

- 明确各实体及关联的学习者归属规则，尤其是知识点经由材料分析、目标、学习者知识记录关联时的可见性规则。
- 保持业务用例使用明确的学习者范围，避免依赖全局单用户状态假设。

**service**

- 扩展 repository 契约和 memory / SQLite 实现，提供按 `learnerId` 读取、写入与资源归属检查能力；避免多用户场景下无界全量状态读写造成越权或并发覆盖。
- 为账号与学习者、验证码挑战、会话增加持久化 schema 与迁移；数据访问对用户范围建立索引和必要的外键约束。
- 将所有上述 API 接入统一的服务端身份解析；登录校验失败返回 `401`。
- 所有创建操作写入当前 `learnerId`；所有按 ID 访问、修改或触发异步工作的操作检查所属关系，越权资源按统一策略返回 `404` 或 `403`。
- 对关联和批量 ID 操作逐项校验，确保材料、分析、知识点、目标、任务、测评及尝试不会跨学习者串联。
- 对异步处理、后台补全、计划刷新等路径传递可信的 `learnerId`，并在持久化更新时再次限定范围。
- 更新演示种子初始化及现有数据迁移，避免演示账号数据落入首个真实用户或暴露给其他用户。

**UI**

- 页面加载和 API 调用依赖会话，不再以固定演示 `learnerId` 作为业务访问身份。
- 处理未登录跳转、会话失效反馈和登录后回跳；不把 `learnerId` 作为客户端授权参数。

#### 验收

- 每个列出的业务接口在未登录时均拒绝访问。
- 两个不同 `userId` / `learnerId` 的用户无法读取、修改或触发对方资源；伪造请求参数中的身份 ID 不改变服务端授权范围。
- 列表、详情、创建、更新、批量选择、提交答题及异步工作均限定到当前学习者。
- memory 与 SQLite repository 行为符合相同的隔离契约；并发保存不会覆盖其他用户的数据。
- 现有演示数据迁移后仍可按既定归属访问，且不与新用户数据混淆。

## 依赖与待实施时确定的细节

- 生产环境部署方式、HTTPS 与 Cookie 域配置需要在实施时确认。
- QQ 邮箱 SMTP 授权码、发件邮箱地址及相关环境变量名在配置阶段确定，不将密钥写入仓库。
- 明确现有数据迁移策略后再执行 schema / 数据迁移；计划不假设匿名公共学习数据。

## 场景实施记录

### 场景 1：邮箱验证码登录与会话鉴权

- 已实现 QQ SMTP 邮箱验证码接口、验证码摘要存储、10 分钟过期、60 秒重发间隔、最多 5 次校验、一次性消费和 30 天服务端会话。
- 已实现 `userId` 与稳定 `learnerId` 关联；首次登录创建空学习者档案，后续通过邮箱恢复同一身份。
- 已实现 HttpOnly、生产环境 Secure、SameSite=Lax Cookie；会话查询及退出撤销接口。
- 已实现邮箱登录 UI、受保护页面跳转、未登录 API 返回 401、退出登录交互。
- 已补充 `FLOW_AUTH_SECRET` 和 QQ SMTP 环境配置说明。SQLite 模式下账号、验证码和会话写入本地数据库；默认 memory 模式重启后会清除登录态。
- 验证：`npm run build` 通过；构建报告项目当前 Next.js 版本受安全公告影响，并有既存的 pdfjs-dist / 动态文件访问警告。
- 范围说明：业务接口已统一要求有效会话，但其数据访问仍待场景 2 接入当前 `learnerId` 并实现 repository 隔离；当前不可将本场景视为多用户数据隔离完成。
