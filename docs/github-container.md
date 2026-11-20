# GitHub 自动构建镜像

仓库：https://github.com/baotuo88/baotuo-ai-family

镜像：`ghcr.io/baotuo88/baotuo-ai-family`

工作流位于 `.github/workflows/container.yml`：

- 向 main 提交 PR：构建 AMD64 镜像，运行 Dockerfile 中的类型检查、编译和测试，并检查新数据卷启动、HTTP 健康、非 root 用户和正常停机。不登录镜像仓库、不发布镜像。
- 推送 main：以上检查通过后，构建并发布 linux/amd64、linux/arm64 镜像，标签为 latest 和 sha-完整提交号。
- 推送 v 开头的标签：检查后发布同名版本标签和 sha 标签，不覆盖 latest。
- Actions 中可以手动运行；仅 main 或 v 标签允许发布，其他分支只验证。

发布使用 GitHub 自动提供的 `GITHUB_TOKEN`，不需要配置 Docker Hub 密码或把 API Key 放进 Actions。仓库或组织需允许 Actions 和 packages:write；首次发布后，在 GitHub Packages 中确认镜像可见性。公开源码仓库不保证镜像包自动公开。

构建含两种架构的编译与测试，ARM64 使用 QEMU，首次构建可能较慢。启动冒烟测试不需要真实 Key、微信账号，不验证 ACP 工具沙箱。部署后仍需执行 docker-deployment.md 中的工具验收。

## 首次上传

当前源目录来自不含 Git 元数据的副本，尚未上传。先在能访问 GitHub 且已完成 Git 认证的机器上克隆目标仓库，再复制当前改造文件到克隆目录，保留目标仓库已有提交与文件。排除 `.env`、`.env.docker`、data、runtime、node_modules、dist 和本地凭据。不要强制推送覆盖目标仓库历史。

提交前检查 `git status` 和暂存差异，确认没有密钥；保留 LICENSE。提交并推送 main 后，在仓库 Actions → Container image 查看构建。成功后 Packages 中应出现镜像。

## 使用已发布镜像

部署机只需要 `compose.yaml` 和从 `.env.docker.example` 复制的 `.env`：

```bash
cp .env.docker.example .env
chmod 600 .env
# 编辑 .env，填写管理令牌；API 地址、Key 和模型可留到 /admin 网页填写。
# GATEWAY_IMAGE 默认 ghcr.io/baotuo88/baotuo-ai-family:latest
docker compose up -d
# 浏览器打开 http://127.0.0.1:18080/admin 配置模型和扫码绑定。
```

默认 Compose 自动拉取镜像、同步卷内机器人配置并启动，不需要源码编译、手动 configure-codex 或 export。管理员联系人授权见 [Docker 部署指南](docker-deployment.md)。

镜像为 private 时先执行 `docker login ghcr.io -u baotuo88`，使用具备 read:packages 权限的 token；不要提交 token。

正式部署建议在 `.env` 将 GATEWAY_IMAGE 固定为 `:v1.0.0` 或 `@sha256:...`。更新镜像或应用配置后运行：

```bash
docker compose up -d
```

`compose.registry.yaml` 保留用于兼容旧命令，但新部署不需要它。源码构建用 `docker compose -f compose.yaml -f compose.build.yaml up -d --build`。

镜像发布成功不等于服务器自动更新。账号、数据库和附件在独立数据卷中，升级前请备份，不要执行 `down -v`。首次扫码及管理员联系人授权仍是人工步骤。

网页初始化、访问安全及配置优先级见 [管理后台指南](admin-dashboard.md)。
