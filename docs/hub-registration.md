# hub 收录登记建议（供 hub 维护者 triage 时复制）

DSH hub 不接受 PR：插件仓库由 hub 的同步循环 + 管理员 triage 收录。本文件是给维护者的**登记建议**，
当同步循环把 `dsh-task2docker-studio` 标记为「未分类」时，直接复制下面两段即可。

前置条件：
- 仓库已公开，并打上 topics：`dsh`、`dsh-plugin`、`agent-skill`、`docker`、`ssh`、`remote-compute`。
- `package.json` 声明了 `dsh.bundle.patch`（`cordis.patch.yml`）→ 管理面板自动推导为 `bundle · cordis`，无需人工覆盖。

## catalog.source.json（repos 数组追加一行）

```json
    { "name": "dsh-task2docker-studio", "category": "plugin", "tags": ["remote-compute", "docker", "ssh", "container"], "note": "任务转容器工作室：把本机跑不动/不敢跑的任务下发到用户自有的 SSH 服务器，可选 Docker 容器隔离；t2d_run 下发、t2d_status/logs 监控（限时跟随）、t2d_copy_to/from 传输文件与产物。厂家中立、无需第三方 API key，凭据仅存指针。附带通用 Agent Skill（SKILL.md + 标准库 CLI）" }
```

## README.md（插件表格，按名字排序插入）

```
| [dsh-task2docker-studio](https://github.com/CarryChang/dsh-task2docker-studio) | bundle · cordis | 任务转容器工作室：把计算从弱机/受限本机卸载到你自己的 SSH 服务器，Docker 容器隔离运行 + scp 文件传输 + 状态/日志跟随监控；厂家中立、凭据仅存指针，附带可装进 Claude Code/Cursor/Copilot 的通用 Agent Skill — Dispatch tasks from a weak host to your own SSH runners with Docker isolation, file transfer and log monitoring — TS | 2026-11-08 |
```

> 本仓库归属为 CarryChang；若 fork 给其他作者，需把上面两段的 URL 与 `package.json` 的 `repository`/`homepage`/`bugs` 一并改掉。
