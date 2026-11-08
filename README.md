# dsh-task2docker-studio

Task-to-Docker studio plugin for [DeepSeek Harness](https://github.com/deepseek-ai): offload compute from a weak or security-constrained host onto **servers you already control**. The host stays a controller — it registers a runner, sends a task, and follows the result.

**Vendor-neutral.** A runner is any machine you can reach over SSH: a cloud server, a GPU box, a cluster entry node. No specific provider, no API key to a third party.

Built for two scenarios:

- **The host is weaker than the target.** A model won't fit, a build is too slow, a batch job is too big — run it on a server that can handle it.
- **Safe execution.** Untrusted or experimental code runs in a throwaway Docker container on that server, isolated from the host you're typing on.

A task runs as a **detached container** when an image is set (recommended for isolation), or **backgrounded on the host** otherwise.

## Also usable as a general Agent Skill

The skill and its tools ship in the open Agent Skills format under [`skills/dsh-task2docker-studio/`](skills/dsh-task2docker-studio) — a `SKILL.md` plus a stdlib-only `scripts/t2d.mjs` CLI. Install it into Claude Code, Cursor, Copilot and other Agent-Skills agents (20+) with no DeepSeek Harness: it is the same dispatch logic, driven from the shell. See [the skill README section](#use-it-as-a-standalone-agent-skill).

## What it gives the agent

| Tool | Purpose |
|---|---|
| `t2d_register_runner` | Add a runner: name, host, port, user, auth (`key`/`sshpass`), optional default image |
| `t2d_list_runners` | Show registered runners (credential pointers only, never the secret) |
| `t2d_remove_runner` | Forget a runner |
| `t2d_run` | Dispatch a command to a runner → a tracked job (container or native) |
| `t2d_status` | Poll a job: RUNNING / SUCCEEDED / FAILED / STOPPED + exit code |
| `t2d_logs` | Tail a job's output |
| `t2d_stop` | Stop a job |

Plus a bundled skill (`task2docker-studio`) that teaches the loop: list → register → confirm → run → status → logs → stop, with container-vs-native and secrecy rules.

## Install (DeepSeek Harness)

```sh
dsh plugin --profile web add https://github.com/CarryChang/dsh-task2docker-studio
```

## Configure

Register runners live (recommended), from chat:

```
> 我有一台服务器 203.0.113.10，root + 公钥免密，名字叫 gpu-box，帮我登记，之后训练都丢它上面跑
```

Or declare them in the profile's `cordis.yml` so they are ready on load:

```yaml
- id: task2docker
  name: dsh-task2docker-studio
  config:
    stateDir: ''                 # default ~/.dsh-task2docker (runners.json + jobs.json)
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
        passwordEnv: ISOLATED_PW # or passwordFile: /run/secrets/isolated_pw
```

### Credentials

- **Key / agent auth** stores nothing secret — the normal path.
- **Password auth (`sshpass`)** stores only a pointer: `passwordEnv` names an environment variable, `passwordFile` names a 0600 file. The password is read at call time, never written to the ledger, and never returned in tool output.

## Try it

```
> 把 ./train.py 丢到 gpu-box 上用 pytorch:2.4 镜像跑起来，跑完告诉我状态
> 这段不受信任的脚本别在我本机跑，去 isolated 上开个容器执行，只看输出
> run npm ci && npm test on my build server and tail the log
```

## Architecture

```
src/
  index.ts             plugin entry: Config + skill + 7 t2d_* tools (the only Cordis-facing file)
  skill.ts             embedded task-to-runner methodology
  backend/             DSH-free, offline-testable
    types.ts           Runner, SshTarget, JobRecord, ExecResult, SshClient, Task2DockerError
    ssh.ts             shell quoting, docker/native command composition, ssh+sshpass argv, SSH client
    registry.ts        runner + job JSON store; password-pointer resolution
    engine.ts          Task2DockerEngine: register / list / remove / run / status / logs / stop
scripts/
  smoke.ts             offline deterministic smoke (fake SSH client + temp store)
  build-portable.mjs   derive the Agent-Skill CLI runtime from compiled DSH-free modules
```

The engine talks to runners through an injected `SshClient`, so the whole dispatch flow is unit-tested offline with a fake. Any SSH-reachable machine is a runner; no vendor SDK anywhere in the backend.

## Use it as a standalone Agent Skill

`skills/dsh-task2docker-studio/` is a self-contained Agent Skill (open format) — install it into Claude Code / Cursor / Copilot by copying the folder or via your agent's skill installer, then drive it through the shell:

```sh
cd skills/dsh-task2docker-studio
node scripts/t2d.mjs register --name gpu-box --host 203.0.113.10 --user root --image pytorch:2.4
node scripts/t2d.mjs run --runner gpu-box --command "python train.py"        # detached container
node scripts/t2d.mjs status --job <id>
node scripts/t2d.mjs logs   --job <id> --tail 80
node scripts/t2d.mjs stop   --job <id>
```

The CLI's compiled runtime lives in `skills/dsh-task2docker-studio/scripts/lib/` (generated from the DSH-free `src/backend/` by `scripts/build-portable.mjs`), so a GitHub clone or a plain folder copy needs no build. `src/*.ts` stays the single source of truth.

## Provenance & license

MIT licensed (see [LICENSE](LICENSE)). v0.1 targeted OpenBayes / HyperAI GraphQL; v0.2 removed that vendor coupling and generalizes to any SSH runner with optional Docker. Not affiliated with or endorsed by DeepSeek, Docker, or any cloud provider.

## Development

```sh
pnpm install     # needs access to the @deepseek-ai registry packages
pnpm run build   # tsc -> lib/  + build:portable -> skills/.../scripts/lib
pnpm run test    # offline deterministic smoke (no network, no ssh)
pnpm run check   # build + smoke
```

## Limitations (v0.2)

- Runners must be SSH-reachable from the host. Containerized runs need Docker on the runner; native runs do not.
- Native background runs track the PID and a log file but do not capture a container-style exit code.
- `sshpass` must be installed on the host for password auth; prefer key auth.
- No file transfer tool yet — copy artifacts with `scp`/`rsync` against the runner, or mount a path in the container.
