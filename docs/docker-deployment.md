# Docker Compose 部署

GitHub 自动发布镜像及免编译部署见 [GitHub 构建指南](github-container.md)。

支持 Docker Engine / Docker Desktop 的 Linux 容器，要求 Docker Compose **2.30+**（使用 `env_file.format: raw`）。镜像使用 Node.js 24 Debian Bookworm 和项目锁定的 Codex / ACP 版本。构建阶段执行类型检查、构建、测试及 Codex 二进制版本检查。

当前仓库已验证 Compose 配置解析及入口脚本测试；本次开发环境不能访问 Docker daemon，**尚未实际完成镜像构建和容器内 ACP 工具执行验收**。

部署后可在 [网页管理后台](admin-dashboard.md) 配置模型和绑定微信；只需预先设置管理令牌。

## 1. 配置

在项目根目录执行：

```bash
cp .env.docker.example .env
chmod 600 .env
openssl rand -hex 32
```

将随机值填入 `.env` 的 `GATEWAY_ADMIN_TOKEN`，模型信息可在后台填写，也可以预先填写：

```dotenv
CODEX_CLI_BASE_URL=https://你的API地址/v1
CODEX_CLI_API_KEY=机器人专用Key
CODEX_CLI_MODEL=你的供应商实际支持的模型
```

容器变量采用 raw 原始值读取，不要给值加外层引号。Compose 同时将 `.env` 用作自身插值来源，含 `$NAME` 的值可能产生未定义变量警告；不要用 `docker compose config` 的输出回写 `.env`（输出会将 `$` 转义为 `$$`）。实际特殊字符凭据应在部署环境检查，勿将配置输出粘贴到公开日志。模型支持的思考强度也需与 `CODEX_CLI_REASONING_EFFORT` 匹配。无需安装宿主机 Node.js、pnpm 或 Codex。

Compose 强制使用容器路径：`DATA_DIR=/data`、认证目录 `/data/codex-home`，管理员和家庭工作区分别为 `/data/runtime/admin`、`/data/runtime/family`。不要把本机安装配置中的程序路径复制到 `.env`。

## 2. 拉取镜像并启动

只需要 compose.yaml 和配置好的 .env；默认镜像为 `ghcr.io/baotuo88/baotuo-ai-family:latest`，必须已由 Actions 发布成功。私有镜像先执行 `docker login ghcr.io`。

```bash
docker compose up -d
docker compose ps
docker compose logs --tail=100 gateway
# 首次在终端显示二维码，用微信扫码；后续无需重复绑定。
docker compose exec gateway node dist/apps/server/setup.js admin
```

`.env` 同时保存 Compose 设置（GATEWAY_IMAGE、GATEWAY_HTTP_PORT、可选 GATEWAY_DATA_VOLUME）和机器人配置，不需要 export 或第二份配置文件。尚无后台配置且环境有 Key 时，服务启动按环境同步机器人专用 config.toml/auth.json；相同内容不重复写入。Key 留空时允许启动进入 /admin 初始化；已有后台配置时跳过环境认证同步。维护/恢复/扫码命令不执行自动同步。

尚未保存后台设置的角色使用环境配置；保存后的角色以后台设置为准。已有手工配置或登录态需要自行管理时，在 `.env` 设置 `GATEWAY_AUTO_CONFIGURE=0`。正常 API Key 部署保留 `1`。更换 Key 时旧文件备份含旧凭据，仍需保护数据卷与备份。

旧用户：把 `.env.docker` 的应用配置合并到 `.env`，保留原镜像/卷名等 Compose 设置，不要覆盖现有密钥。暂不迁移可在 `.env` 设置 `GATEWAY_ENV_FILE=.env.docker`，但这仍是两文件兼容模式。

镜像内置项目锁定的 Codex、ACP 适配器、bubblewrap、Git、Python、ripgrep 和 unzip。Office 转换软件及技能没有自动打包，需要时在派生镜像中安装；不要依赖运行中容器内临时安装的软件。

## 3. 授权管理员联系人

从微信发送 `/whoami`，获得账号 ID 和联系人 ID，然后执行：

```bash
docker compose exec gateway node dist/apps/server/admin-contacts.js grant '账号ID' '联系人ID'
docker compose exec gateway node dist/apps/server/admin-contacts.js list
```

账号角色为 admin 且联系人已授权，才有管理员能力。添加家庭账号：

```bash
docker compose exec gateway node dist/apps/server/setup.js family --force
```

## 4. 访问与验证

默认只向宿主机发布 `127.0.0.1:18080`。无需把端口开放到公网，iLink 使用出站轮询。

```bash
curl -fsS http://127.0.0.1:18080/healthz
# Basic 用户名 admin，交互输入管理令牌作为密码。
curl -u admin http://127.0.0.1:18080/api/accounts
curl -u admin http://127.0.0.1:18080/api/jobs

docker compose exec gateway node dist/apps/server/doctor.js --env-only
docker compose exec gateway node dist/apps/server/doctor.js --env-only --api
docker compose exec gateway node dist/apps/server/doctor.js --env-only --acp-session
```

`--api`、`--acp-session` 会调用模型，可能消耗额度。Docker healthcheck 只检查 `/healthz`，不代表微信登录、模型认证或工具沙箱可用。

容器内工具隔离取决于宿主机内核、用户命名空间和 Docker 安全策略。先检查 bubblewrap：

```bash
docker compose exec gateway bwrap --unshare-user --unshare-pid --unshare-net --ro-bind / / --proc /proc --dev /dev /bin/true
```

然后在没有其他模型任务执行时运行实际工具测试（会生成少量测试文件并消耗模型额度）：

```bash
docker compose exec gateway node dist/apps/server/codex-compat-regression.js
```

若默认 Docker 策略明确阻止 bubblewrap 创建命名空间，可选择兼容覆盖：

```bash
docker compose -f compose.yaml -f compose.sandbox.yaml up -d
docker compose -f compose.yaml -f compose.sandbox.yaml exec gateway node dist/apps/server/codex-compat-regression.js
```

该覆盖会放宽外层 seccomp/AppArmor 过滤，需评估后使用；它不禁用 family 的文件权限配置，也不启用 privileged、不挂载宿主机 Docker socket。宿主机完全禁用用户命名空间时，该覆盖仍可能无效，需调整宿主机配置或改用支持该能力的 Linux 环境。不要通过禁用 family 沙箱来绕过问题。

## 5. 数据与权限

`gateway-data` 命名卷挂载到 `/data`，包含：

- SQLite 数据库、轮询游标、消息和任务状态；
- `codex-home` 机器人认证；
- `runtime` 执行工作区及 ACP 运行目录；
- `inbox`、`office`、`outbox` 附件和成品；
- `backups` 备份、`.maintenance` 数据锁及恢复前副本。

镜像以 `node` 用户（UID/GID 1000）运行，新命名卷继承镜像内 `/data` 的所有权。如果换成 bind mount，请事先让 UID 1000 能写入该目录。入口脚本不会自动 chown 宿主机挂载目录。

机器人操作发生在容器内；它不能直接管理宿主机 systemd、个人 Codex 或宿主机文件。当前 Compose 没有挂载个人 `~/.codex`、项目源码或 Docker socket。

`docker compose down` 保留数据；**`docker compose down -v` 会删除命名卷**。删除卷前请导出备份和必要认证配置。不要同时用多个网关实例操作同一个卷。

## 6. 备份与恢复

```bash
docker compose exec gateway node dist/apps/server/backup.js
# 用输出中的实际路径验证，并复制到宿主机：
docker compose exec gateway node dist/apps/server/backup.js --verify /data/backups/实际时间目录
docker compose cp gateway:/data/backups/实际时间目录 ./gateway-backup
```

备份不包含 `.env` 和 `codex-home`，这些需要独立保管。在线备份保证 SQLite 一致性；若要求附件与数据库同一时点，先停服务，用一次性容器备份：

```bash
docker compose stop gateway
docker compose run --rm gateway node dist/apps/server/backup.js
docker compose up -d
```

恢复数据卷中已有备份：

```bash
docker compose stop gateway
docker compose run --rm gateway node dist/apps/server/backup.js --restore /data/backups/实际时间目录 --yes
docker compose up -d
```

若从宿主机备份恢复，使用只读挂载（备份目录需允许容器 UID 1000 读取）：

```bash
docker compose stop gateway
docker compose run --rm -v "$PWD/gateway-backup:/restore:ro" gateway node dist/apps/server/backup.js --restore /restore --yes
docker compose up -d
```

不要在恢复时运行 setup、accounts 等其他写数据命令。详细故障恢复规则见 [可靠性指南](reliability-setup.md)。

## 7. 更新与自定义

修改 `.env` 后，重新创建服务才能读取新环境；仅 `restart` 不更新环境变量：

```bash
# 自动拉取镜像，配置变化时重新创建容器并同步机器人配置。
docker compose up -d
```

需要从源码构建时才使用额外文件（不拉取发布镜像）：

```bash
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

普通镜像更新只需 `docker compose up -d`。

Codex 版本仍由 package.json 和锁文件决定，不会跟随宿主机 Codex 升级。需要回退镜像时，先为当前镜像打保留标签，数据库变化另外通过已验证的备份处理。

更换宿主机端口：

```bash
GATEWAY_HTTP_PORT=18081 docker compose up -d
```

指定另一份配置文件：

```bash
GATEWAY_ENV_FILE=/absolute/path/bot.env docker compose up -d
```

Compose 固定项目名 `baotuo-ai-family`，要部署多个独立机器人时使用不同的 `-p` 项目名和宿主机端口，以创建不同数据卷。

## 从旧 Compose 项目名称迁移

新项目名 `baotuo-ai-family` 默认创建 `baotuo-ai-family_gateway-data` 卷，不会自动读取原 `weixin-household-gateway_gateway-data`。先停止旧服务并备份，通过 `docker volume ls` 确认旧卷实际名称。需要复用旧卷时，在执行 Compose 的 shell 中设置：

```bash
export GATEWAY_DATA_VOLUME=weixin-household-gateway_gateway-data
docker compose up -d
```

该变量选择已有卷；不要让新旧服务同时使用同一个卷。数据库文件名保留 `weixin-household-gateway.sqlite`，无需改名。
