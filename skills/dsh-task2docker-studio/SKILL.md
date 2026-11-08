---
name: dsh-task2docker-studio
description: Offload compute from a weak or security-constrained host onto servers you control. Register any SSH-reachable runner (a cloud server, a GPU box, a cluster node), dispatch a command to it as a detached Docker container for isolation or backgrounded on the host, then follow status, logs and stop. Use when the user wants work to run on another machine they ssh into. Ships a stdlib CLI so it works in Claude Code, Cursor, Copilot and other Agent-Skills agents with no DeepSeek Harness.
license: MIT
metadata:
  version: 0.5.0
  author: CarryChang
  homepage: https://github.com/CarryChang/dsh-task2docker-studio
  keywords: remote-compute, docker, ssh, container, task-dispatch, agent-skill
---

# dsh-task2docker-studio — dispatch tasks to your own servers

The host is a **controller**; a runner the user registers does the compute. A runner is any machine
reachable over SSH — a cloud server, a GPU box, a cluster entry node. Send a command to it as a detached
Docker container (isolation) or backgrounded on the host, then poll status, tail logs and stop. Vendor-neutral.

Reach for this when: the host is too weak for the job, the user wants untrusted code isolated in a
container, or the user simply wants tasks run on a server they already have.

## Fixed workflow

1. **List runners** — see what is registered. If none, ask the user for the server, then **register** it.
2. **Run** — dispatch one command to a named runner; it starts a tracked job and returns a job id. With an
   image (per-run or the runner default) it runs as a detached container; otherwise it runs backgrounded.
   Restate what will run where, and the cost, before a heavy or destructive command.
3. **Status** — RUNNING / SUCCEEDED / FAILED / STOPPED plus the exit code.
4. **Logs** — the last lines of output, to show or diagnose.
5. **Stop** — remove the container / kill the process.
6. **Remove runner** — only when the user asks to forget a server.

## Commands (run with plain Node, no dependencies)

```sh
# Register a runner (key auth is the default and stores no secret).
node scripts/t2d.mjs register --name gpu-box --host 203.0.113.10 --user root --image pytorch:2.4

# Password auth stores only a pointer (an env var name or a 0600 file path), never the secret:
node scripts/t2d.mjs register --name isolated --host 203.0.113.20 --auth sshpass --password-env ISOLATED_PW

# Dispatch a command. With an image it starts a detached container; --native runs on the host instead.
# --mount host:container binds a staged host path into the container (repeatable; add :ro for read-only).
node scripts/t2d.mjs run --runner gpu-box --command "python train.py"
node scripts/t2d.mjs run --runner gpu-box --command "python /data/src/train.py" --mount /data/src:/workspace
node scripts/t2d.mjs run --runner gpu-box --command "pytest -q" --native

# Move files: push code/data/skill to the runner, pull artifacts back (--recursive for folders).
node scripts/t2d.mjs copyto    --runner gpu-box --local ./src --remote /data/src --recursive
node scripts/t2d.mjs copyfrom  --runner gpu-box --remote /data/out --local ./out --recursive

# Follow up.
node scripts/t2d.mjs list
node scripts/t2d.mjs status --job <id>
node scripts/t2d.mjs logs   --job <id> --tail 80 --follow 60   # live-sample 60s then return
node scripts/t2d.mjs stop   --job <id>
node scripts/t2d.mjs remove --name isolated
```

Every command prints one JSON object: `{ ok: true, result }` or `{ ok: false, error }`, and exits non-zero
on error. Run commands from this skill directory.

## Container vs native

- Container is the default when an image exists: isolation, a clean filesystem, no leftover host state — the
  recommended path for untrusted or experimental work.
- Native (`--native`, or a runner with no image) runs the command directly on the host, backgrounded with a
  log file. Use it when the work must touch host state or no container runtime is set up. Native runs track a
  PID and log but do not capture a container-style exit code.

## Failure translation

- No runner named X — list and register it; never guess a host.
- Job start failed — read the reason: unreachable host, auth rejected, or `docker` missing on the runner.
  Missing docker means pick `--native` or install Docker.
- `sshpass` missing on the host — password auth cannot run; switch the runner to key auth or install sshpass.
- Status MISSING / UNKNOWN — the container was removed or the host rebooted; re-dispatch if needed.

## Security boundary

- State (runners + job ledger) is plain JSON under `$T2D_STATE_DIR` (default `~/.dsh-task2docker`), written 0600.
- Passwords are resolved at call time from the env var name or 0600 file given at register, and never stored
  or printed. Key / agent auth stores nothing secret.
- The runner is a machine the user controls and trusts; treat dispatched commands as full-trust there and
  confirm before destructive ones. No postinstall, no bundled binaries; the CLI only shells out to `ssh`,
  `sshpass` (password auth only) and `docker` on the runner.
