# dsh-task2docker-studio

Task-to-Docker studio plugin for [DeepSeek Harness](https://github.com/deepseek-ai): let the agent offload compute from a weak or security-constrained host onto external GPU/container runners. The host stays a controller — it sends a task, a remote container executes it.

Built for two scenarios:

- **The host is weaker than the cluster.** A model won't fit, a build is too slow, a batch job is too big. Ship it to a GPU container and pull the result back.
- **Safe execution.** Untrusted or experimental code runs in a throwaway container, isolated from the host.

Under the hood it drives [OpenBayes](https://openbayes.com) / [HyperAI](https://hyperai.tech) job compute over GraphQL, and reaches running containers over SSH.

## What it gives the agent

| Tool | Purpose |
|---|---|
| `t2d_whoami` | Account identity, balance, debt, quota minutes, active-job count |
| `t2d_catalog` | Container images (runtimes) and compute tiers (resources) with affordability / full-load gates |
| `t2d_dispatch` | Send a task: create a `TASK` (one-shot command) or `WORKSPACE` job on the remote cluster |
| `t2d_status` | Poll a job and read its access links (ssh password is never returned) |
| `t2d_jobs` | List the account's own WORKSPACE / TASK jobs |
| `t2d_exec` | Run one command inside a RUNNING container over SSH |
| `t2d_stop` | Stop / cancel a job |

Plus a bundled skill (`task2docker-studio`) that teaches the safe loop: whoami → catalog → confirm → dispatch → poll → exec → stop, with container path (`/output`, `/input*`) and secrecy rules.

## Install

```sh
dsh plugin --profile web add https://github.com/CarryChang/dsh-task2docker-studio
```

## Configure credentials

Option A — environment (recommended, keeps secrets out of files):

```
T2D_ENDPOINT=https://api.openbayes.com/graphql
T2D_TOKEN=<personal access token>     # OPENBAYES_TOKEN is also honored
```

Option B — the plugin config block in your profile's `cordis.yml`:

```yaml
- id: task2docker
  name: dsh-task2docker-studio
  config:
    endpoint: 'https://api.openbayes.com/graphql'
    token: ''                 # or leave empty and use T2D_TOKEN / OPENBAYES_TOKEN
    defaultResource: ''       # e.g. a100-1; used when a dispatch omits resource
    defaultRuntime: ''        # e.g. pytorch-2.11-py312-cu124
    confirmDispatch: true     # require confirm:true before any spend
    sshTimeoutSec: 30
```

The token is never returned in tool output and never written to the session log. Per-job SSH passwords are resolved internally for `t2d_exec` and redacted everywhere else.

## Try it

```
> 本机跑不动，帮我把这个训练脚本丢到一张 A100 上跑，跑完把 checkpoint 拉回来
> 在隔离容器里安全地跑一下这段不受信任的代码，只看输出别让它碰本机
> dispatch a batch job to the cluster and stream its logs back
```

## Architecture

```
src/
  index.ts             plugin entry: Config + skill + 7 t2d_* tools (the only Cordis-facing file)
  skill.ts             embedded task-to-docker methodology
  backend/             DSH-free, offline-testable
    types.ts           DTOs, SupportedMode/JobStatus, Task2DockerError, GraphQLTransport
    transport.ts       bearer normalization, fetch GraphQL client, silent-null guard
    operations.ts      GraphQL documents + validated CreateJobInput builder
    ssh.ts             ssh-link parsing, non-interactive sshpass/ssh argv builders
    runner.ts          Task2DockerRunner: whoami / catalog / dispatch / status / jobs / exec / stop
    executor.ts        production RemoteExecutor over sshpass (temp 0600 password file)
```

The backend talks to the platform through an injected `GraphQLTransport` and a `RemoteExecutor` seam, so the whole dispatch flow is unit-tested offline with fakes. Swapping the compute vendor means changing documents in `operations.ts` and the transport; tool signatures and the skill contract stay identical.

## Provenance & license

The GraphQL control plane and container-development rules are adapted from the open-source
`openbayes-user` agent skill. This plugin is MIT licensed (see [LICENSE](LICENSE)). It is an
independent work and is not affiliated with or endorsed by OpenBayes, HyperAI, or DeepSeek.

## Development

```sh
pnpm install     # needs access to the @deepseek-ai registry packages
pnpm run build   # tsc -> lib/
pnpm run test    # offline deterministic smoke (no network, no credentials)
pnpm run check   # build + smoke
```

## Limitations (v0.1)

- Compute providers: OpenBayes / HyperAI job GraphQL only. Other clusters attach behind the transport seam.
- Job modes: `TASK` and `WORKSPACE` only. VM / batch / sandbox are never created on a user's behalf.
- `t2d_exec` requires `sshpass` on the host for password auth; otherwise dispatch the command through a `TASK` job or install an SSH key.
- Login / token issuance stays outside the plugin; provide an existing personal access token.
