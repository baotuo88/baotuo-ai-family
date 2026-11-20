# baotuo-ai-family

本项目 `baotuo-ai-family` 是一个基于 TypeScript/Node.js 的微信家庭 AI 网关。
它整合 iLink 微信消息轮询、角色路由、Codex 后端、本地文件工作区和适合微信聊天的输出策略，形成一个可部署的单服务。

项目目标不是把完整网页 agent 产品照搬进微信，而是在微信这个消息环境里提供一个可靠、可控、分权的 AI 入口：

- `admin` 拥有持久 ACP 会话，适合运维、代码、文件和长任务。
- `family` 默认走更安全的路径：普通聊天优先直连 API，复杂文件任务再升级到非持久 ACP，并受更严格的权限策略约束。

当前仓库为 [baotuo88/baotuo-ai-family](https://github.com/baotuo88/baotuo-ai-family)，维护分支为 `main`。当前代码位于根目录；旧 ACP 实现见 [历史实现](#historical-acp-implementation)。

## 独立配置与可靠性改造

当前默认使用 `DATA_DIR/codex-home` 保存机器人认证，不沿用个人 `CODEX_HOME`。管理 HTTP 默认仅监听 `127.0.0.1`，除 `/healthz` 外需要 `GATEWAY_ADMIN_TOKEN`。admin 账号还需显式授权联系人。消息先持久化再执行，多账号独立轮询、全局限制任务并发，备份提供快照与完整性校验。

首次使用或从旧版本迁移，请阅读 [配置、授权与恢复指南](docs/reliability-setup.md)。

## 验证与运行诊断

统一源码验证入口 `pnpm verify` 覆盖类型检查、清理重建、测试和隔离启动冒烟检查；`pnpm test` 不再直接测试旧 `dist`。管理后台可查看任务执行与投递状态、筛选任务并人工关闭待检查任务；不确定的投递结果不会被标记为已接受，也不会自动重发。`/readyz` 在轮询尚未就绪时返回 503，`/healthz` 只表示进程存活。

使用方式、兼容性变化及剩余阶段见 [运行诊断与任务处置](docs/operations.md)。

## 项目能力

- 多微信账号接入，支持 `admin` / `family` 角色分权。
- iLink 轮询、typing 状态续期、文本回复、附件下载、文件回传。
- `family` 普通聊天优先直连 API：
  - 优先 `/responses`；
  - 不支持时回退 `/chat/completions`；
  - 支持约 100k 字符预算的 family API 上下文轨道、稳定 prompt cache key 和图片/文本附件输入。
- ACP 工具型后端：
  - `admin` 使用持久 ACP 会话；
  - `family` 使用非持久 ACP 会话；
  - 收集 ACP status、工具进度、可见文本 run，并提取最终回答。
- 微信友好的输出体验：
  - 单轮可见消息预算；
  - 最终回答固定作为最后一条发送；
  - 可配置 ACP 过程输出；
  - 可配置 `family-api` 保守提前发送；
  - `family` 输出过滤路径、命令片段和疑似内部推理文本。
- 角色化提示词和上下文策略：
  - `admin` 默认依赖持久 ACP 会话；
  - `family-api` 维护约 100k 字符预算的独立 API 上下文轨道；
  - `family-acp` 只带 deterministic carryover、短尾巴和当前任务信息；
  - 默认提示词放在 `prompts/` 目录，可通过环境变量指向自定义模板。
- `admin` 默认不自动轮转，用户用 `/new` 手动新建会话；`family` 默认启用热聊保护，只在冷场后才允许按跨天、空闲、轮数或 token 阈值轮转。
- SQLite 存储账号、会话、消息、附件和轮询游标。
- 会话工作区：`inbox` 入站文件、`office` 中间文件、`outbox` 可回传成品。
- 运维工具：doctor 自检、备份/恢复、账号设置、Codex 配置生成、文件发送。

## 架构概览

```mermaid
flowchart LR
  WX["微信联系人 / 群聊"]
  ILINK["iLink API<br/>轮询 / typing / 发送 / 媒体"]

  subgraph GATEWAY["Node.js 单服务"]
    direction TB
    WORKER["WechatWorker<br/>账号轮询 / 消息归一化 / 单轮并发控制"]
    TURN["会话与输入准备<br/>角色模式 / 热聊保护 / 附件落盘"]
    ROUTE{"命令或任务路由"}
    REPLY["输出编排<br/>消息预算 / 过程提示 / 最终回复"]

    WORKER --> TURN --> ROUTE
  end

  subgraph BACKENDS["Codex 执行层"]
    direction LR
    ADMIN["admin-acp<br/>持久 ACP 会话"]
    FAPI["family-api<br/>轻量聊天，优先 /responses"]
    FACP["family-acp<br/>复杂附件和工具任务"]
  end

  SUPPORT[("支撑资源<br/>SQLite / prompts / inbox / office / outbox")]
  OPS["运维入口<br/>HTTP / setup / doctor / backup / send-file"]

  WX <--> ILINK
  ILINK --> WORKER
  ROUTE -->|内建命令| REPLY
  ROUTE -->|admin| ADMIN
  ROUTE -->|family 轻量| FAPI
  ROUTE -->|family 复杂| FACP
  ADMIN --> REPLY
  FAPI --> REPLY
  FACP --> REPLY
  REPLY --> ILINK

  GATEWAY -. 读写状态和文件 .-> SUPPORT
  BACKENDS -. 使用配置和工作区 .-> SUPPORT
  OPS -. 管理和备份 .-> SUPPORT

  classDef edge fill:#eef2ff,stroke:#818cf8,color:#312e81;
  classDef gateway fill:#eff6ff,stroke:#60a5fa,color:#172554;
  classDef decision fill:#fefce8,stroke:#facc15,color:#713f12;
  classDef backend fill:#ecfdf5,stroke:#34d399,color:#064e3b;
  classDef support fill:#fff7ed,stroke:#fb923c,color:#7c2d12;

  class WX,ILINK edge;
  class WORKER,TURN,REPLY gateway;
  class ROUTE decision;
  class ADMIN,FAPI,FACP backend;
  class SUPPORT,OPS support;
```

主链路：

```text
微信消息 -> iLink 轮询 -> WechatWorker -> 会话/附件准备 -> 内建命令或角色路由
  -> Codex 后端 -> 输出策略 -> iLink 发送 -> 微信回复 / 文件回传
```

## 后端路由

| 角色/场景 | 默认后端 | 会话持久性 | 典型用途 |
| --- | --- | --- | --- |
| `admin` | ACP | 持久 | 运维、代码、多步骤工具任务 |
| `family` 普通聊天 | API | 非持久 | 日常对话、轻量问答 |
| `family` 复杂任务 | ACP | 非持久 | 压缩包、文档、复杂附件、工具任务 |

`family` 普通文本和图片聊天优先走 direct API。压缩包、Office 文档等复杂附件会升级到 ACP，让 Codex 在受控工作区里处理文件。

## 输出模型

微信不支持原地 token 级流式刷新，所以项目使用微信原生的多消息体验：

- 单轮可见消息预算由 `WECHAT_TURN_MESSAGE_LIMIT` 控制，默认 10 条；
- 预算中的最后 1 条固定留给最终回答；
- 前 `N-1` 条用于 ACP 过程输出、30 秒思考提示或 `family-api` 早发；
- 过程输出指 Codex 对外可见的阶段性说明和工具调用进度；
- `admin-acp` 默认开启过程输出；
- `family-acp` 默认关闭过程输出；
- `family-api` 提前分段默认关闭，可按会话开启；
- 用户可用 `/output` 调整当前会话输出行为。

| 模式 | 默认过程输出 | 30s 思考提示 | 过程/分段限制 |
| --- | --- | --- | --- |
| `admin-acp` | 开 | 关闭 | 最多占用前 `N-1` 条，至少间隔 15 秒；发送 `visible_message_run` 和工具进度 |
| `family-acp` | 关 | 开 | 默认不发 ACP 过程；开 `/output process on` 后最多 4 条且不超过前 `N-1` 条，至少间隔 8 秒，只发可见文本块，不发工具进度 |
| `family-api` | 早发默认关 | 开 | 开 `/output family-api-stream on` 后最多提前发 2 条且不超过前 `N-1` 条，至少 60 字，至少间隔 2.5 秒，只在强边界切 |

`family-api` 未开启早发时，会等 API 完整返回后再发最终回答。最终回答保持为最后一组消息；当文本超过 iLink 单条限制时，发送层会按字符和 UTF-8 字节限制拆分，完整保留文本。逻辑消息预算不等于底层文本分片数量。

`family-api` 维护独立的 API 聊天轨道，不把 ACP 工具任务的长过程直接混入 API
上下文；这条轨道约有 100k 字符预算，超出后优先按完整旧轮次裁剪，尽量保持
缓存前缀稳定。ACP 完成后只把最后可见答案作为 task note 交回 API 轨道，同样受
100k 字符预算约束，避免复杂文件任务结束后把有效结论压得过短。prompt cache key 按
账号和联系人稳定生成，避免新 session 直接打散缓存。当前兼容 HTTP `/responses`
接口不支持 `previous_response_id` 连续上下文，所以项目不会依赖该字段。

默认配置：

```dotenv
WECHAT_TURN_MESSAGE_LIMIT=10
WECHAT_ADMIN_PROGRESS_ENABLED=true
WECHAT_FAMILY_PROGRESS_ENABLED=false
WECHAT_FAMILY_API_STREAMING_ENABLED=false
SESSION_ADMIN_AUTO_ROTATE_ENABLED=false
SESSION_FAMILY_AUTO_ROTATE_ENABLED=true
SESSION_FAMILY_HOT_IDLE_MINUTES=90
```

ACP 事件、`final_message_run`、过程输出限制和开发注意事项见
[ACP 工作流](docs/acp-workflow.md)。

角色提示词、上下文注入和缓存策略见 [提示词与上下文策略](docs/prompting.md)。

## 目录结构

```text
apps/server/src/
  codex/        Codex 后端、ACP 连接、ACP collector、API backend
  commands/     微信内建命令
  config/       环境变量驱动的运行配置
  files/        MIME 推断和文件工具
  http/         health、ready、登录与账号 API
  policy/       family 输出过滤与敏感信息处理
  router/       账号角色解析
  sessions/     会话 memory、轮转、工作区路径和时间工具
  storage/      SQLite schema 与数据库封装
  transport/    iLink transport、worker、媒体和文件处理
  utils/        通用工具

docs/           运维与开发文档
infra/          Linux 安装/卸载脚本和 systemd 集成
legacy/agent-acp/  旧 ACP 最终源码与设计文档（历史参考）
docs/history/     迁移证据、路径表、原始 Git bundle
```

常见部署目录：

```text
/opt/baotuo-ai-family          项目代码和构建产物
/var/lib/baotuo-ai-family      SQLite 数据、附件和工作区
  inbox/                              入站文件
  office/                             中间文件
  outbox/                             可发回微信的成品文件
DATA_DIR/codex-home/                  机器人专用 Codex 配置和认证
```

## GitHub 镜像自动构建

推送到 `main` 后，GitHub Actions 会验证并发布 `ghcr.io/baotuo88/baotuo-ai-family:latest`，同时支持 AMD64/ARM64；PR 只检查、不发布。首次上传与拉取镜像部署见 [GitHub 构建指南](docs/github-container.md)。镜像仅在工作流成功后才可拉取。

## Docker Compose 部署与管理后台

只需 `compose.yaml` 和一份 `.env`，无需服务器源码编译、Node.js 或 Codex。要求 Docker Compose 2.30+，镜像已由 GitHub Actions 成功发布。

```bash
cp .env.docker.example .env
chmod 600 .env
# 至少填写 GATEWAY_ADMIN_TOKEN（openssl rand -hex 32 生成）；模型配置可留到网页填写。
docker compose up -d
```

打开 `http://127.0.0.1:18080/admin`，在独立登录页使用用户名 `admin` 和管理令牌登录。在后台依次完成 **模型配置与连接测试 → 微信扫码绑定 → 联系人授权**，也可查看运行状态和异常任务。

远程服务器使用 SSH 隧道或 HTTPS 反向代理访问；不要直接公开明文管理端口。模型配置加密保存在持久卷，重启不丢失，有任务执行时不强制热切换。

使用说明及配置优先级见 [管理后台指南](docs/admin-dashboard.md)；源码构建、备份和迁移见 [Docker 部署指南](docs/docker-deployment.md)。

## 安装

建议使用普通登录用户安装，不要在 `sudo su -` 后安装。

```bash
curl -fsSL https://raw.githubusercontent.com/baotuo88/baotuo-ai-family/main/infra/scripts/linux/bootstrap.sh | bash
```

无交互安装示例：

```bash
curl -fsSL https://raw.githubusercontent.com/baotuo88/baotuo-ai-family/main/infra/scripts/linux/bootstrap.sh | \
BOOTSTRAP_YES=1 \
CODEX_CLI_AUTH_MODE=api_key \
CODEX_CLI_BASE_URL=https://your-openai-compatible-endpoint/v1 \
CODEX_CLI_API_KEY=sk-... \
bash
```

安装器会检测环境、安装运行依赖、构建服务、写入 `.env`、创建 systemd 服务，并
在首次绑定时显示微信二维码。第一个扫码账号会成为 `admin`。

Linux 部署时，安装器会处理 Codex CLI、`bubblewrap`/`bwrap` 兼容和 admin 运维沙箱参数；细节见
[Codex 配置](docs/codex-setup.md)。

## 开发

要求：

- Node.js `>=22.5.0`
- pnpm `10.13.1`

常用命令：

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test:wxbot
pnpm test:reliability
pnpm test:runtime
cp .env.example .env
# 按 .env.example 填写运行配置，再启动
pnpm start
```

服务构建命令：

```bash
tsc -p apps/server/tsconfig.json
```

部署后的常用工具：

```bash
node dist/apps/server/doctor.js --acp-session
node dist/apps/server/configure-codex.js --apply
node dist/apps/server/setup.js family --force
node dist/apps/server/backup.js
```

## 运维

```bash
sudo systemctl status baotuo-ai-family
journalctl -u baotuo-ai-family -f

cd /opt/baotuo-ai-family
git pull --ff-only origin main
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test:wxbot
pnpm test:reliability
pnpm test:runtime
node dist/apps/server/configure-codex.js --apply
sudo systemctl restart baotuo-ai-family
```

备份和恢复：

```bash
node dist/apps/server/backup.js
node dist/apps/server/backup.js --restore /path/to/backup --yes
```

卸载：

```bash
bash infra/scripts/linux/uninstall.sh --yes --keep-data
bash infra/scripts/linux/uninstall.sh --yes
```

## 相关文档

- [Codex 配置](docs/codex-setup.md)
- [ACP 工作流](docs/acp-workflow.md)
- [提示词与上下文策略](docs/prompting.md)
- [微信命令](docs/commands.md)
- [Windows 本地测试](docs/windows-local-test.md)

## 名称兼容

当前项目名为 `baotuo-ai-family`。为兼容已有数据，数据库仍使用 `weixin-household-gateway.sqlite`；ACP 只读目录元数据沿用原协议标识，与锁文件中的补丁保持一致。已有 Compose 部署迁移前请备份；新项目名默认创建新数据卷，迁移方法见 Docker 部署指南。原项目 MIT 版权声明和历史归档保持保留。

## Historical ACP implementation

旧 `weixin-household-agent-acp` 已停止独立维护。它是本项目的早期实现：旧仓后期已使用 Gateway 产品名，新仓继续整理和发展同一套代码。历史源码、原 README、架构、提示词和部署文件位于 [legacy/agent-acp/](legacy/agent-acp/README.md)，当前运行请使用本仓根目录。

- [项目关系与迁移记录](docs/history/agent-acp-migration.md)
- [完整迁移报告](docs/history/migration-report-2026-10-04.md)
- [服务器部署与更新](docs/server-deployment.md)

旧 Git 历史原样保留在 `archive/agent-acp` 分支及 `archive/agent-acp-final-20260503` 标签；原始 bundle 和恢复命令见迁移记录。微信小程序登录/runtime 研究属于独立项目，本次没有合并或修改。

## 友链/社区

- [linux.do](https://linux.do/)
