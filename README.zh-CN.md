# dsh-task2docker-studio

[DeepSeek Harness](https://github.com/deepseek-ai) 的「任务转容器」插件：让 agent 把计算从性能较弱或安全受限的宿主机，卸载到外部 GPU/容器算力上执行。宿主机只做控制——下发任务，远端容器负责计算。

面向两类场景：

- **宿主机弱于计算集群。** 模型放不下、构建太慢、批处理太大——丢到 GPU 容器跑，再把结果取回。
- **安全执行。** 不受信任或试验性代码在一次性容器里隔离运行，不碰宿主机。

底层通过 GraphQL 驱动 [OpenBayes](https://openbayes.com) / [HyperAI](https://hyperai.tech) 的 job 计算，并通过 SSH 操作运行中的容器。

## 给到 agent 的能力

| 工具 | 作用 |
|---|---|
| `t2d_whoami` | 账户身份、余额、欠款、配额分钟数、运行中任务数 |
| `t2d_catalog` | 容器镜像（runtime）与算力档位（resource），带可负担/满载闸门 |
| `t2d_dispatch` | 下发任务：在远端集群创建 `TASK`（一次性命令）或 `WORKSPACE` job |
| `t2d_status` | 轮询 job、读取访问链接（ssh 密码永不返回） |
| `t2d_jobs` | 列出本账户的 WORKSPACE / TASK job |
| `t2d_exec` | 在 RUNNING 容器内经 SSH 执行一条命令 |
| `t2d_stop` | 停止 / 取消 job |

外加内置技能（`task2docker-studio`），教授安全闭环：whoami → catalog → 确认 → dispatch → 轮询 → exec → stop，含容器路径（`/output`、`/input*`）与保密规则。

## 核心工作流

固定闭环，宿主机始终只当控制端：

1. **t2d_whoami** —— 会话开头读一次账户画像：身份、余额、欠款、配额分钟数、在跑任务数。锁定或有欠款，先告知用户再谈下发。
2. **t2d_catalog** —— 列出集群可用镜像（runtime）与算力档位（resource）。runtime/resource 只能取自这里，带 `affordable` / `isFullLoad` 闸门，任一不过即当前不可用。
3. **t2d_dispatch** —— 下发任务：`TASK` 把命令编进 job 跑完即退；`WORKSPACE` 起交互式容器。**先复述配置与计费后果、拿到用户同意**，再带 `confirm:true` 调用（`confirmDispatch=true` 是代码级门槛，不是提示词约定）。
4. **t2d_status** —— 轮询到 `RUNNING` 才有 ssh / 服务链接；链接从返回里读，绝不拿 job id 拼 URL。
5. **t2d_exec**（可选）—— 在 RUNNING 容器里经 SSH 跑一条命令、取小产物；真正的大训练更推荐直接编进 `TASK` 下发。
6. **t2d_stop** —— 收尾或取消。`TASK` 停止即终止，`WORKSPACE` 之后可重启。

容器内的数据落点：`/output` 跨重启持久、是工作目录；`/input0`–`/input4` 只读挂数据集；二者之外都是会丢的系统盘。

## 安装

```sh
dsh plugin --profile web add https://github.com/CarryChang/dsh-task2docker-studio
```

## 配置凭据

方式 A —— 环境变量（推荐，密钥不落文件）：

```
T2D_ENDPOINT=https://api.openbayes.com/graphql
T2D_TOKEN=<个人访问令牌>     # 也识别 OPENBAYES_TOKEN
```

方式 B —— profile `cordis.yml` 里的插件配置块：

```yaml
- id: task2docker
  name: dsh-task2docker-studio
  config:
    endpoint: 'https://api.openbayes.com/graphql'
    token: ''                 # 留空则读取 T2D_TOKEN / OPENBAYES_TOKEN
    defaultResource: ''       # 如 a100-1；下发未指定 resource 时使用
    defaultRuntime: ''        # 如 pytorch-2.11-py312-cu124
    confirmDispatch: true     # 任何花费前要求 confirm:true
    sshTimeoutSec: 30
```

令牌不会出现在工具输出里，也不会写入会话日志。每个 job 的 SSH 密码只在 `t2d_exec` 内部解析，其余地方一律脱敏。

## 试用

```
> 本机跑不动，帮我把这个训练脚本丢到一张 A100 上跑，跑完把 checkpoint 拉回来
> 在隔离容器里安全地跑一下这段不受信任的代码，只看输出别让它碰本机
> 把一批任务下发到集群，把日志流回来
```

## 架构

```
src/
  index.ts             插件入口：Config + 技能 + 7 个 t2d_* 工具（唯一接触 Cordis 的文件）
  skill.ts             内置「任务转容器」方法论
  backend/             与 DSH 无关、可离线测试
    types.ts           DTO、SupportedMode/JobStatus、Task2DockerError、GraphQLTransport
    transport.ts       bearer 归一、fetch GraphQL 客户端、静默 null 拦截
    operations.ts      GraphQL 文档 + 受校验的 CreateJobInput 构造器
    ssh.ts             ssh 链接解析、非交互式 sshpass/ssh argv 构造
    runner.ts          Task2DockerRunner：whoami / catalog / dispatch / status / jobs / exec / stop
    executor.ts        生产 RemoteExecutor（sshpass，临时 0600 密码文件）
```

后端通过注入的 `GraphQLTransport` 与 `RemoteExecutor` 抽象与平台交互，整条下发链路都用假实现离线单测。更换算力厂商只需改 `operations.ts` 里的文档与传输层，工具签名与技能契约保持不变。

## 出处与许可

GraphQL 控制面与容器开发规则改写自开源 `openbayes-user` agent 技能。本插件采用 MIT 许可（见 [LICENSE](LICENSE)），为独立作品，与 OpenBayes、HyperAI、DeepSeek 无隶属或背书关系。

## 开发

```sh
pnpm install     # 需要访问 @deepseek-ai registry 包
pnpm run build   # tsc -> lib/
pnpm run test    # 离线确定性冒烟（无网络、无凭据）
pnpm run check   # 构建 + 冒烟
```

## 限制（v0.1）

- 算力提供方：仅 OpenBayes / HyperAI job GraphQL。其它集群经传输层抽象接入。
- job 模式：仅 `TASK` 与 `WORKSPACE`。VM / 批量 / sandbox 永不代用户创建。
- `t2d_exec` 的密码认证依赖宿主机上的 `sshpass`；否则请把命令编进 `TASK` job 下发，或配置 SSH 公钥。
- 登录 / 令牌签发在插件之外；请提供已有的个人访问令牌。
