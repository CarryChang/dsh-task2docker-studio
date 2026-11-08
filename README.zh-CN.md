# dsh-task2docker-studio

[DeepSeek Harness](https://github.com/deepseek-ai) 的「任务转容器」插件：把计算从性能较弱或安全受限的宿主机，卸载到**你自己拥有的服务器**上执行。宿主机只做控制端——注册一台 runner、下发任务、跟进结果。

**不绑定任何厂家。** runner 就是你用 SSH 能连上的任意机器：云服务器、GPU 机器、集群登录节点。无需第三方 API key。

面向两类场景：

- **宿主机弱于目标机。** 模型放不下、构建太慢、批处理太大——丢到扛得住的服务器上跑。
- **安全执行。** 不受信任或试验性代码在那台服务器的一个一次性 Docker 容器里跑，与你正在打字的本机隔离。

任务在设了镜像时以**分离式容器**运行（推荐用于隔离），否则**在宿主机后台运行**。

## 同时可作为通用 Agent Skill

技能与工具已按开放 Agent Skills 格式放在 [`skills/dsh-task2docker-studio/`](skills/dsh-task2docker-studio)：一份 `SKILL.md` 加一个纯标准库的 `scripts/t2d.mjs` 命令行。无需 DeepSeek Harness，即可装进 Claude Code、Cursor、Copilot 等 20+ agent，用 shell 直接驱动同一套下发逻辑。见[下方独立用法](#作为独立-agent-skill-使用)。

## 给到 agent 的能力

| 工具 | 作用 |
|---|---|
| `t2d_register_runner` | 登记 runner：name、host、port、user、auth（`key`/`sshpass`）、可选默认镜像 |
| `t2d_list_runners` | 列出已登记 runner（只显示凭据指针，绝不显示密钥） |
| `t2d_remove_runner` | 忘记一台 runner |
| `t2d_copy_to` | 把本地文件/目录（代码、数据、skill）通过 scp 推到 runner |
| `t2d_copy_from` | 把产物（checkpoint、报告）从 runner 拉回本地 |
| `t2d_run` | 把一条命令下发到 runner → 受跟踪的 job（容器或原生）；可用 `mounts` 把宿主机路径挂进容器 |
| `t2d_status` | 轮询 job：RUNNING / SUCCEEDED / FAILED / STOPPED + 退出码 |
| `t2d_logs` | 取 job 输出末尾若干行，或在限定秒数内实时跟随，监控容器内任务执行 |
| `t2d_stop` | 停止 job |

外加内置技能（`task2docker-studio`），教授闭环：list → register → copy_to → run(带 mounts) → status → logs → copy_from → stop，含容器 vs 原生、文件传输与保密规则。

## 核心工作流

固定闭环，宿主机始终只当控制端：

1. **t2d_list_runners** —— 先看有没有已登记的机器；没有就问用户要服务器信息，用 **t2d_register_runner** 添加：name、host，可选 port（22）/user（root）/auth，并可给一个 defaultImage，之后下发自动进容器。
2. **t2d_copy_to** —— 任务需要本地代码/数据/skill 时，先把文件 scp 到 runner 的某个宿主机路径，再用 **t2d_run** 的 `mounts` 把它挂进容器；不要把文件内容内联进命令。
3. **t2d_run** —— 把一条命令下发到指定 runner，后台起一个 job 并返回 job id。有镜像就以分离式 Docker 容器跑；否则 nohup 后台跑。重活或破坏性命令先复述「在哪跑、跑什么、代价」再动手。
4. **t2d_status** + **t2d_logs** —— 用 job id 查状态与退出码；`t2d_logs` 可取末尾日志，也可给一个 `follow` 秒数窗口实时跟随，在不阻塞的前提下监控容器内任务的执行进展。
5. **t2d_copy_from** —— 把 checkpoint、报告等产物从 runner 拉回本地。
6. **t2d_stop** / **t2d_remove_runner** —— 取消任务（容器 `docker rm`、原生 `kill`）；仅在用户要忘记服务器时才 remove。

## 安装（DeepSeek Harness）

```sh
dsh plugin --profile web add https://github.com/CarryChang/dsh-task2docker-studio
```

## 配置

推荐在对话里现场登记 runner：

```
> 我有一台服务器 203.0.113.10，root + 公钥免密，名字叫 gpu-box，帮我登记，之后训练都丢它上面跑
```

或在 profile 的 `cordis.yml` 里预置，加载即可用：

```yaml
- id: task2docker
  name: dsh-task2docker-studio
  config:
    stateDir: ''                 # 默认 ~/.dsh-task2docker（runners.json + jobs.json）
    sshTimeoutSec: 60
    runners:
      - name: gpu-box
        host: 203.0.113.10
        user: root
        auth: key
        defaultImage: nvidia/cuda:12.4.1-base-ubuntu22.04
      - name: isolated
        host: 203.0.113.20
        auth: sshpass
        passwordEnv: ISOLATED_PW # 或 passwordFile: /run/secrets/isolated_pw
```

### 凭据

- **公钥 / agent 认证**不存任何密钥——常规路径。
- **密码认证（sshpass）**只存一个指针：`passwordEnv` 指明环境变量名，`passwordFile` 指明 0600 文件路径。密码在调用瞬间读取，绝不写进台账，也不出现在任何工具输出里。

## 试用

```
> 把 ./train.py 丢到 gpu-box 上用 pytorch:2.4 镜像跑起来，跑完告诉我状态
> 这段不受信任的脚本别在我本机跑，去 isolated 上开个容器执行，只看输出
> 在我构建机上跑 npm ci && npm test，并把日志 tail 回来
```

把本地代码传到 runner、挂载进容器、实时跟随日志、再拉回产物：

```sh
node scripts/t2d.mjs copyto --runner gpu-box --local ./src --remote /data/src --recursive
node scripts/t2d.mjs run --runner gpu-box --command "python /data/src/train.py" --mount /data/src:/workspace
node scripts/t2d.mjs logs --job <id> --follow 60 --tail 80
node scripts/t2d.mjs copyfrom --runner gpu-box --remote /data/out --local ./out --recursive
```

## 架构

```
src/
  index.ts             插件入口：Config + 技能 + 7 个 t2d_* 工具（唯一接触 Cordis 的文件）
  skill.ts             内置「任务转 runner」方法论
  backend/             与 DSH 无关、可离线测试
    types.ts           Runner、SshTarget、JobRecord、ExecResult、SshClient、Task2DockerError
    ssh.ts             shell 引号、docker/原生命令拼装、ssh+sshpass argv、SSH 客户端
    registry.ts        runner + job 的 JSON 台账；密码指针解析
    engine.ts          Task2DockerEngine：register / list / remove / run / status / logs / stop
scripts/
  smoke.ts             离线确定性冒烟（假 SSH 客户端 + 临时台账）
  build-portable.mjs   从编译后的无 DSH 依赖模块派生 Agent Skill 运行时
```

引擎通过注入的 `SshClient` 与 runner 交互，整条下发链路都用假实现离线单测。任何能 SSH 到的机器都是 runner，后端里没有任何厂家 SDK。

## 作为独立 Agent Skill 使用

`skills/dsh-task2docker-studio/` 是自成一体的开放格式 Agent Skill——复制该目录或用你 agent 的技能安装器装入 Claude Code / Cursor / Copilot，然后用 shell 驱动：

```sh
cd skills/dsh-task2docker-studio
node scripts/t2d.mjs register --name gpu-box --host 203.0.113.10 --user root --image pytorch:2.4
node scripts/t2d.mjs run --runner gpu-box --command "python train.py"        # 分离式容器
node scripts/t2d.mjs status --job <id>
node scripts/t2d.mjs logs   --job <id> --tail 80
node scripts/t2d.mjs stop   --job <id>
```

CLI 的编译运行时在 `skills/dsh-task2docker-studio/scripts/lib/`（由 `scripts/build-portable.mjs` 从无 DSH 依赖的 `src/backend/` 生成），所以 GitHub 克隆或整目录拷贝都无需构建。`src/*.ts` 始终是唯一事实来源。

## 出处与许可

MIT 许可（见 [LICENSE](LICENSE)）。v0.1 面向 OpenBayes / HyperAI GraphQL；v0.2 去除了厂家耦合，泛化为任意 SSH runner + 可选 Docker。与 DeepSeek、Docker 或任何云厂商无隶属或背书关系。

## 开发

```sh
pnpm install     # 需要访问 @deepseek-ai registry 包
pnpm run build   # tsc -> lib/  + build:portable -> skills/.../scripts/lib
pnpm run test    # 离线确定性冒烟（无网络、无 ssh）
pnpm run check   # 构建 + 冒烟
```

## 限制（v0.2）

- runner 必须能从本机 SSH 连上。容器化运行需要 runner 上有 Docker；原生运行不需要。
- 原生后台运行记录 PID 和日志文件，但不采集容器式退出码。
- 密码认证需要本机安装 `sshpass`；优先用公钥认证。
- 暂无文件传输工具——产物用 `scp`/`rsync` 对拷，或在容器里挂载路径。
