# GitHub Actions 自动部署

每次向 `main` 推送提交会触发 `.github/workflows/deploy.yml`。GitHub Actions 通过 SSH 登录服务器，在应用目录更新到 `origin/main`，执行 `npm ci` 和 `npm run build`，然后使用 PM2 重载名为 `flow` 的进程；服务器没有 PM2 时则重启 `flow` systemd 服务。

## 一次性服务器准备

服务器需要 Node.js/npm、Git，以及 PM2 或 systemd。先部署一次代码并准备运行环境：

1. 创建专用部署用户，在其家目录下克隆此仓库，确保该用户能读取 GitHub 仓库。
2. 配置项目需要的环境变量（参考仓库 `.env.example`）。SQLite 数据文件需保存在仓库目录之外或被 `.gitignore` 忽略的位置，并做好备份。
3. 初始化应用进程。PM2 示例：`pm2 start npm --name flow -- start && pm2 save`。或者创建名为 `flow` 的 systemd 服务，工作目录指向仓库，启动命令为 `npm run start`，并配置环境变量。
4. 将 GitHub Actions 使用的 SSH 公钥加入部署用户的 `~/.ssh/authorized_keys`。建议限制该密钥仅用于部署。

## GitHub 仓库 Secrets

在仓库 **Settings → Secrets and variables → Actions** 添加：

| Secret | 值 |
| --- | --- |
| `DEPLOY_HOST` | 服务器域名或 IP |
| `DEPLOY_USER` | SSH 部署用户名 |
| `DEPLOY_SSH_KEY` | 对应的 SSH 私钥（完整 PEM/OpenSSH 内容） |
| `DEPLOY_PATH` | 服务器上的仓库绝对路径 |
| `DEPLOY_PORT` | SSH 端口；省略时使用 22 |

服务器部署用户还需有权访问 GitHub 仓库，以便执行 `git fetch origin main`。Workflow 可在 Actions 页面手动触发，或通过推送 `main` 自动触发。
