# 独立配置、授权与故障恢复

这版保留原有微信和模型路由，改变了默认认证目录与管理员授权条件。升级已有服务前请停服务并备份，不能假定旧个人 Codex 登录态、旧管理 HTTP 调用或旧账号角色直接沿用。

## 首次配置

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test:wxbot
pnpm test:reliability
pnpm test:runtime
cp .env.example .env
node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
```

将最后生成的随机值填入 `.env` 的 `GATEWAY_ADMIN_TOKEN`，不要提交 `.env`。

```dotenv
HOST=127.0.0.1
PORT=18080
DATA_DIR=./data
GATEWAY_ADMIN_TOKEN=填写至少32字符的随机令牌
CODEX_CLI_AUTH_MODE=api_key
CODEX_CLI_HOME=
CODEX_CLI_BASE_URL=https://你的供应商/v1
CODEX_CLI_API_KEY=填写机器人专用Key
```

`CODEX_CLI_HOME` 留空时使用 `DATA_DIR/codex-home`，不继承个人 `CODEX_HOME`。管理员和家庭配置可以通过 `CODEX_ADMIN_HOME` / `CODEX_FAMILY_HOME` 显式覆盖；显式指定个人目录仍会共享该目录，因此请使用机器人专用路径。Linux 安装器也默认使用数据目录下的 `codex-home`。

```bash
pnpm codex:configure -- --apply
pnpm setup -- admin
pnpm start
```

程序版本仍固定在 package.json / pnpm-lock.yaml，本次没有升级 Codex 或 ACP，也没有增加自动升级。

## 管理接口

除 `/healthz` 外所有 HTTP 路由都需要认证。令牌未配置或短于 32 字符时管理接口返回 503；无效认证返回 401。支持：

- 脚本：`Authorization: Bearer <管理令牌>`；
- 浏览器二维码页面：HTTP Basic 用户名 `admin`，密码为管理令牌。

不支持 URL 查询参数传递令牌。HTTP 默认只监听本机；远程使用可通过 SSH 端口转发访问本机端口，或在 TLS 反向代理后部署。浏览器跨来源请求会被拒绝。

```bash
# 使用 -u admin 交互输入密码，不将令牌放在 URL 中。
curl -u admin http://127.0.0.1:18080/api/accounts
curl -u admin http://127.0.0.1:18080/readyz
curl -u admin http://127.0.0.1:18080/api/jobs
```

新接口：`GET /api/admin-contacts` 列出授权；`POST /api/admin-contacts` 接受 JSON：

```json
{"accountId":"接入账号ID","contactId":"发送者ID","allowed":true}
```

将 `allowed` 设为 `false` 撤销授权。管理令牌控制全部管理功能，请仅交给实际管理员。

## 管理员联系人

admin 能力要求同时满足：接入账号角色为 admin，发送者在该账号的联系人白名单中。旧 admin 账号不会自动授权任何联系人。

1. 从微信发 `/whoami`，获得账号和联系人 ID（此命令不调用模型）。
2. 在服务所在电脑/服务器上授权：

```bash
pnpm contacts -- grant '账号ID' '联系人ID'
pnpm contacts -- list
pnpm contacts -- revoke '账号ID' '联系人ID'
```

每个排队任务实际开始时重新读取账号状态和联系人授权。撤销后，下一个任务不再有管理员权限，旧 admin 会话会归档，新 family 会话不携带其摘要和附件；显式切换 `/mode` 也会开启独立会话；family 的 `/last`、`/yesterday` 不返回 admin 会话。已经执行中的任务不因授权变化自动停止，需要先发 `/stop` 或停止服务。

## API 与运行检查

```bash
pnpm doctor
pnpm doctor -- --api
pnpm doctor -- --acp-session
```

普通 doctor 显示可执行程序、版本、配置目录、管理令牌配置状态和联系人授权数量。

`--api` 对当前 `.env` 中 admin/family API 配置分别发起一次最小文本请求，走正式后端的 Responses / Chat Completions 回退逻辑，可能消耗少量 API 额度。检查不执行模型工具，不输出 Key 或供应商错误响应正文；成功仅代表能得到有效文本，不验证 ACP 工具权限。微信 `/provider` 在数据库中保存的动态覆盖不属于这一项基础配置检查。

## 消息可靠性

轮询到的归一化消息和新游标在同一 SQLite 事务中提交。以 `(wechat_account_id, source_message_id)` 唯一键去重，再按联系人排队执行。

| 状态 | 含义 |
| --- | --- |
| queued | 已落盘、未开始；重启后恢复，停用账号暂不执行 |
| running | 已开始，可能已经调用工具或发送回复 |
| succeeded | 处理函数正常结束 |
| needs_review | 执行抛错或服务重启时发现中断；不自动重跑 |

`GET /api/jobs` 返回最近 100 条任务元数据及各状态总数 `counts`，不返回原始消息内容。对 `needs_review` 应先检查聊天记录、文件和日志，再从微信发送一条新请求。当前不提供一键自动重试，防止重复执行命令或发送文件。

这是去重和保守恢复机制，不承诺外部副作用 exactly-once：上游缺少 client_id 时沿用内容指纹作为来源 ID，极少数内容完全相同的消息可能合并；崩溃前已发出的回复或已执行的工具无法通过数据库回滚。进程锁限制同一数据目录只运行一个网关。

## 备份、校验与恢复

```bash
pnpm backup
pnpm backup -- --out /path/to/new-backup-directory
pnpm backup -- --verify /path/to/backup-directory
# 先停止网关，再恢复：
pnpm backup -- --restore /path/to/backup-directory --yes
```

默认备份位于 `DATA_DIR/backups/<时间>`，不覆盖已有目录；自定义目标必须在数据目录外，或在其 `backups` 子目录内。

- SQLite 使用 `VACUUM INTO` 生成一致性快照，支持源库处于 WAL 模式。
- 清单记录文件 SHA-256；校验同时检查文件集合、哈希和 SQLite 完整性。
- 拒绝符号链接，避免把目录外文件带入备份。
- 不备份 `.env`、`DATA_DIR/codex-home`、历史备份或 `.maintenance`；自定义凭据目录应放在数据目录外。
- 备份包含微信账号认证令牌，目录设为 0700，备份文件设为 0600，请妥善保管。
- 在线备份保证数据库一致性，文件复制不与数据库形成同一时点快照；需要完整一致的数据库和附件时先停服务。

恢复先验证并暂存文件，再替换业务数据，保留 `codex-home` 和 `backups`。旧业务数据保存在 `DATA_DIR/.maintenance/before-restore-*`。服务持有 SQLite 进程锁时拒绝恢复。若恢复中途断电，`restore-in-progress` 标记会阻止服务启动；管理员应根据该文件中的旧数据目录及暂存目录检查并恢复完整数据后再删除标记。不要直接删除标记强行启动。

旧版本的纯文件复制备份没有清单，本工具不会把它当成已验证备份；需要人工校验后单独迁移。

## 多账号与任务容量

每个 active 账号使用独立长轮询；一个账号等待消息或失败不会阻塞其他账号。连续失败时按 1、2、4、8、16、30 秒退避，成功后重置；账号启停最多约 1 秒内被轮询管理器发现。非零 iLink `ret` / `errcode` 不会推进游标。

```dotenv
WECHAT_MAX_CONCURRENT_TASKS=4
```

普通任务全局最多并发 4 个，可配置 1–32（超过 32 按 32 处理）。同一账号和联系人只调度最早一条未完成任务，后续消息留在 SQLite 中；已停用账号不占调度容量。任务完成后立即补位，无需等待下一次微信轮询。

`/stop` 和 `/cancel` 使用独立控制通道（最多 4 个），普通任务满载时仍能处理。同一联系人的停止命令之间也保持顺序。停止命令仅取消当前任务，不清除排队消息；需要暂停后续消息时停用账号。

停机先中止轮询并向所有已登记任务发出取消信号，再等待收尾；未开始的消息保留在数据库。附件传输和已提交的外部工具仍需要各自完成或超时，不承诺立即终止所有外部副作用。

family 文件回传会解析真实路径；禁止通过文件或 outbox 目录符号链接访问其他会话或外部文件。
