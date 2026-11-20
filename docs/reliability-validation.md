# 改造与运行优化验证记录

验证环境：Node.js v24.21.0，macOS。本次只修改项目源码和文档，没有配置真实 API Key、绑定微信或启动常驻服务。

## 已通过

- `node --test tests/*.test.mjs`：31 项通过。
- 核心配置、配置生成、联系人管理、存储、备份、数据锁、HTTP 认证/请求体处理、命令处理、API 检查及角色解析模块的针对性 TypeScript 检查。
- `bash -n infra/scripts/linux/install.sh`。

测试包含事务原子性与去重、排队消息恢复、中断任务隔离、管理员联系人授权及撤销、管理路由认证、个人配置保护、WAL 快照与恢复、损坏备份拒绝、运行中恢复拒绝、符号链接拒绝、API 协议回退和敏感错误隐藏、实际 Worker 权限降级及任务失败状态、模式切换后的管理员历史隔离，以及账号并行轮询、并发容量、停止命令优先处理、停机取消、轮询错误游标保护、旧队列迁移和文件符号链接越界拒绝。

测试不访问真实微信或模型：Worker 测试替换模型工厂，API 测试模拟 fetch；SQLite、备份和配置文件操作使用真实临时文件。测试产物由本机已有 TypeScript 编译器生成。

## 尚未通过完整环境验证

- `pnpm install --frozen-lockfile`：registry.npmjs.org DNS 解析失败。
- 离线安装：缓存缺少 codex-acp 等包。
- 全项目 TypeScript 检查：缺少 `@agentclientprotocol/sdk`、`qrcode` 等依赖，产生模块缺失及相关类型推导错误。不能把局部检查成功视为完整构建通过。
- 未进行真实微信收发、模型 API 调用、ACP 沙箱、systemd 安装及恢复中断的机器断电测试。

在联网环境安装完整依赖后，执行：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test:wxbot
pnpm test:reliability
pnpm test:runtime
```

然后按照 reliability-setup.md 配置机器人专用凭据、管理令牌及联系人授权，再执行 doctor 和真实联调。Codex / ACP 版本与锁文件未主动升级。

## Docker Compose 封装验证

- 默认 compose.yaml 及叠加 compose.sandbox.yaml 均通过 Docker Compose 2.35.1 配置解析。
- 检查确认管理端口绑定宿主机 127.0.0.1、持久卷挂载 /data，未启用 privileged。
- 容器入口脚本目录初始化、参数/退出码传递、无效目录拒绝测试通过。
- entrypoint.sh 通过 sh -n，healthcheck.cjs 通过 node --check。
- doctor 增加 --env-only，允许 Compose 注入环境配置而不挂载 .env。
- Docker daemon socket 在当前环境被禁止访问，因此没有完成实际 docker build、up、healthcheck 或容器 ACP 沙箱验证。
- 全项目本地 TypeScript 检查仍被缺失的 ACP SDK、qrcode 及其关联类型推导错误阻断；Docker 构建会先安装锁文件依赖，并强制通过 check/build/test 后才产出运行镜像。

## GitHub 发布及重命名

- 当前项目名称改为 baotuo-ai-family，目标仓库为 https://github.com/baotuo88/baotuo-ai-family。
- 数据库旧文件名及 ACP 补丁元数据键保留，避免已有数据和锁文件补丁失配；历史归档及 LICENSE 保留。
- 工作流 YAML 解析、内嵌 Bash 语法及 registry Compose 合并配置通过本地检查；未在 GitHub Actions 上实际运行。
- registry 覆盖文件确认移除了 build，并使用 ghcr.io/baotuo88/baotuo-ai-family 镜像。
- 当前目录无 Git 元数据，GitHub CLI 未安装；读取远程仓库时，本机代理连接失败，禁用代理后 github.com DNS 解析失败。尚未上传代码、触发工作流或发布镜像。

## 2026-11-19 第一批工程优化验证

本批实现统一源码验证入口、任务阶段/处置审计、运行状态与轮询就绪判断、family ACP 失败保护。详细接口及行为变更见 [运行诊断与任务处置](operations.md)。

- 使用本机已有 TypeScript 5.9.3 将**当前源码**逐文件转译到独立 `/tmp` 目录，运行全部测试：**39 项通过，0 失败**（原 31 项 + 新增 8 项）。未覆盖项目原有 dist，也未伪造缺失的生产依赖。逐文件转译不包含完整类型检查，不等同于正式构建。
- 存储、任务 HTTP 处理、运行诊断、权限规则模块使用严格选项通过针对性 TypeScript 检查；借用本机已有 Node 类型声明（25.3.3），并非锁文件环境验证。
- `scripts/verify.mjs`、`scripts/smoke.mjs` 通过 Node 语法检查。验证入口回归覆盖依赖缺失拒绝旧产物、编译失败不执行测试、清理后执行新产物。
- 标准 `node scripts/verify.mjs` 正确因依赖缺失而失败，没有继续测试旧 dist。
- 尝试使用可写的临时 Corepack 缓存下载 pnpm，因 `registry.npmjs.org` DNS 解析失败而阻断。
- 全项目类型检查仍被 ACP SDK、qrcode 缺失及其关联类型推导错误阻断；完整依赖安装、正式构建、真实启动冒烟、Docker 构建、微信/模型/沙箱联调尚未通过本轮验证。
- ACP 失败保护测试使用模拟连接验证拒绝逻辑，不代表真实操作系统沙箱的穿透验证。

## 2026-11-19 单 `.env` 镜像部署

- 默认 compose.yaml 改为拉取 GHCR 镜像，读取 `.env`，无 build；源码构建移至 compose.build.yaml，registry 覆盖保留兼容。
- 容器正常启动自动执行静默、仅变更时写入的机器人配置同步；维护命令不触发同步，可用 GATEWAY_AUTO_CONFIGURE=0 关闭。
- Docker Compose 2.35.1 成功解析默认配置、build、registry、sandbox 覆盖；验证镜像、拉取策略、端口和自动配置开关。config 输出对 `$` 使用 `$$` 序列化转义，未进行实际容器内特殊字符验证。
- 当前源码临时转译后的全部测试：41 项通过（新增入口自动配置及配置幂等性 2 项）。configure-codex.ts 针对性严格类型检查、entrypoint.sh 语法检查通过。
- 未执行真实镜像拉取/启动；完整锁定依赖构建与外部联调限制同上一节。新行为需要将本批代码发布为新镜像后才会在部署端生效。

## 2026-11-19 网页管理后台

- 增加 `/admin`（及根路径）后台页面：运行概览、分角色 API/ACP 配置、连接测试、扫码绑定、角色与联系人授权、任务查询/人工关闭。原 JSON 服务索引移至 `/api`。
- 模型配置在数据卷内 AES-256-GCM 加密持久化；不回显密钥，保留空 Key 更新语义。更新有任务时返回 409；保存失败保留原后端。ACP 持久会话增加配置指纹，避免切换供应商/模型/密钥后继续复用旧会话。
- 无模型 Key 可启动后台；已有后台配置时容器启动不再从旧环境覆盖认证。
- 当前源码转译到独立临时目录运行全部测试：52 项通过，0 失败。包含设置校验/加密/重启加载、备份恢复、认证/同源保护、忙时拒绝、持久化失败回滚、模拟连接测试与扫码路由，以及 ACP 会话指纹。
- 新增设置模块、设置路由、页面生成及存储模块针对性严格 TypeScript 检查通过。全项目检查仍存在缺失 ACP SDK/qrcode 及关联类型错误，不能视为完整构建通过。
- 借用本机已有 jsdom 做临时 DOM 交互验证：导航、表单保存与密钥清空、恶意联系人文本安全渲染、空任务列表均通过。没有新增前端生产依赖；此验证不等同于真实浏览器截图和微信扫码联调。
- entrypoint.sh 和 smoke.mjs 语法检查通过。未访问真实微信/模型、未上传代码或发布镜像；部署需先完成联网安装构建与实际验收。
