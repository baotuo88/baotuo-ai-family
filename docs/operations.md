# 验证、运行诊断与任务处置

## 从源码验证

```bash
pnpm install --frozen-lockfile
pnpm verify
```

`verify` 和默认 `test` 使用同一个入口：类型检查 → 删除旧服务构建产物 → 重新构建（错误时不输出）→ 测试 → 新数据目录启动冒烟检查。冒烟检查使用隔离环境，无微信账号，不调用模型，验证 HTTP 存活、管理认证、无账号时未就绪及 SIGTERM 停机。

`test:runtime`、`test:reliability`、`test:wxbot` 同样先检查并重建，再运行指定测试。`test:compiled` **只测试已有 dist**，仅用于明确知道构建来源的诊断，不可作为源码验收依据。Docker 构建也调用 `pnpm verify`。

## 健康与运行状态

除 `/healthz` 外，下述接口均要求 `Authorization: Bearer $GATEWAY_ADMIN_TOKEN`。

- `GET /healthz`：进程 HTTP 存活，继续供 Docker 使用。
- `GET /readyz`：业务轮询就绪。无有效账号、Worker 未运行、任一活动账号尚未成功轮询、成功时间超过 120 秒、或连续失败达到 3 次时返回 **503**；否则 200。
- `GET /api/status`：Worker 状态、活动任务数、各账号最后成功/失败轮询时间、连续失败次数、任务数量及最早排队/执行时间。

轮询指标是进程内状态，重启后重新观测。`modelChecked=false`、`sandboxChecked=false` 明确说明这里没有执行付费模型请求或沙箱探测；轮询就绪不代表模型可用。多个账号中任一异常都会使 `/readyz` 返回 503，但不会重启其他正常账号；不要把它替换为 Docker 存活检查。

任务生命周期和轮询失败增加 JSON 日志：`job_started`、`job_succeeded`、`job_needs_review`、`poll_failed`。任务日志使用 jobId 关联，成功/失败记录 durationMs，不记录消息正文、凭据和上游错误原文。其他旧日志尚未全部结构化。

## 异常任务处置

```bash
curl -H "Authorization: Bearer $GATEWAY_ADMIN_TOKEN" http://127.0.0.1:18080/api/jobs
curl -H "Authorization: Bearer $GATEWAY_ADMIN_TOKEN" http://127.0.0.1:18080/api/jobs/123
curl -X POST -H "Authorization: Bearer $GATEWAY_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"action":"dismiss","confirm":true,"note":"已核实已有结果，无需再次执行"}' \
  http://127.0.0.1:18080/api/jobs/123/resolve
```

- 列表保留最新 100 条，任务详情可按 ID 查询；不返回消息 payload、context token 或账号认证信息。
- 记录 processing/executing/delivering 阶段、独立的投递状态、开始/结束时间和固定错误码。后台优先显示最近列表中的待人工检查任务。
- 投递状态 `accepted` 只表示发送接口接受请求，不代表用户已读或一定看到；`uncertain` 表示发送期间报错或服务中断，不能据此判断消息未送达。执行阶段只是最后观测位置，不是精确失败根因，也不证明工具是否产生副作用。
- 重启中断使用 `interrupted_execution`；执行抛错使用 `processing_failed`。
- 只有 `needs_review` 可以关闭；关闭后为 `failed`，不会重排队。重复/不合法状态返回 409，缺失任务返回 404。
- 必须明确确认并填写 1–500 字说明；状态变化与处置记录在同一事务内写入。
- 使用共享管理令牌，审计身份只能记为 `management-token`，**不能声称识别了某个管理员**。不要在处置说明里填写敏感信息；已知密钥格式会做脱敏，但不是通用隐私过滤器。
- 不提供自动重放或一键重试。执行结果与发送接口接受状态分别记录，但工具副作用与微信投递不属于同一事务；对 `needs_review` 或 `uncertain` 任务需人工核实已有副作用，重新发消息可能重复执行任务。

## family 权限失败保护

- ACP 返回的权限选项没有匹配类型时，不再回退到第一个选项；没有拒绝选项时取消请求。
- 越界路径、未知路径范围、只读目录及高风险命令的拒绝不能被模型复核推翻。当前拒绝分类均为硬拒绝，因此旧的“模型复核后放行”路径被收紧；需要新增复核场景时，必须先增加明确、可测试的安全分类。
- family ACP 在关闭工作区隔离时直接拒绝执行；连接/沙箱初始化失败直接向上传递，不切换到无沙箱执行。
- family 初始 agent mode 固定为 read-only，不接受继承环境的覆盖。

这些保护不是沙箱穿透测试，也不意味着基于命令文本的规则能识别全部间接执行；实际隔离仍依赖 Codex/操作系统沙箱。

## 工作区文件清理

`pnpm cleanup` 只生成清理预览；只有追加 `--apply` 才会删除文件。清理命令使用数据目录锁，必须先停止网关。默认保留期限为 30 天、工作区目标容量为 10 GiB，可通过 `DATA_RETENTION_DAYS`、`DATA_MAX_WORKSPACE_BYTES` 或命令参数覆盖：

```bash
pnpm cleanup
pnpm cleanup -- --days 60 --max-bytes 5368709120 --json
pnpm cleanup -- --apply
```

只扫描 `inbox/`、`office/`、`outbox/`。超过保留期限的旧文件进入候选；仍超容量时，再从最旧的非活动会话文件开始补足。活动会话工作区受保护。符号链接会使预览失败，避免跟随目录外路径；应用计划时会复核文件大小，预览后发生变化的文件会跳过。聊天记录、会话摘要、SQLite、备份、`codex-home` 和运行工作区不在清理范围内。这个容量上限是离线清理目标，不会阻断新附件下载；若受保护数据本身超过上限，命令会明确报告无法满足。

## 后续阶段

- 加密备份与恢复演练。
- 自动告警、模型用量与延迟统计、分后端并发配额。
- Worker 调度/轮询/回复模块的大规模拆分。
- 真实微信/API/ACP、Docker 构建及部署验证。
