---
name: task2docker-studio
description: "Offload compute from a weak or security-constrained host onto servers you control. Register any SSH-reachable runner (a cloud server, a GPU box, a cluster node), then dispatch a command to it as a detached Docker container for isolation or backgrounded on the host, and follow its status, logs and stop. Vendor-neutral — an ssh target is the only requirement."
---

# Task-to-Docker: dispatch work to your own runners

You are a controller. The host does not run the workload; a runner the user registered does. A runner
is any machine reachable over SSH — a cloud server, a GPU box, a cluster entry node. Choose where the
work runs, start it, watch it, stop it. Confirm before you start anything heavy.

## When this applies

- The host is weaker than the target: a model will not fit, a build is too slow, a batch job is too big.
- Safety isolation: untrusted or experimental code should run in a throwaway container, not on the host.
- The user has their own server and just wants tasks sent to it.

## Fixed call order

1. `t2d_list_runners` to see what is already registered. If none, ask the user for the server and use `t2d_register_runner` to add it: name, host, optional port (22) and user (root), auth `key` or `sshpass`, and optionally a `defaultImage` so later runs containerize automatically.
2. `t2d_copy_to` when the task needs local code, data or a skill on the runner. Push it to a host path, then bind that path into the container with `t2d_run` mounts — never paste file contents through commands.
3. `t2d_run` to dispatch one command to a named runner. It starts and tracks a job and returns a job id. With an image (per-call or the runner default) it runs as a detached container; without one it runs backgrounded on the host. Restate what will run where, and the resource cost, before a heavy run.
4. `t2d_status` (RUNNING / SUCCEEDED / FAILED / STOPPED + exit code) and `t2d_logs` to watch how the in-container task runs — a one-shot tail, or a bounded `follow` window that live-samples for N seconds then returns.
5. `t2d_copy_from` to pull artifacts (checkpoints, reports, outputs) back to the local machine.
6. `t2d_stop` to cancel a job; `t2d_remove_runner` only to forget a server.

## Container vs native

- **Container** is the default when an image exists: isolation, a clean filesystem, no leftover host state. Recommended for untrusted or experimental work.
- **Native** (`t2d_run` with `native: true`, or a runner with no image) runs the command directly on the host, backgrounded with a log file. Use it when the work must touch host state or no container runtime is set up.

## Getting files on and off the runner

- Send code, datasets or a skill with `t2d_copy_to` (recursive for folders), then make it visible inside a container with `t2d_run` mounts: each mount maps a host path to a container path, optionally read-only. The normal sequence is copy_to a host directory, then mount it.
- Bring results back with `t2d_copy_from` — checkpoints, reports, anything the task wrote to a host path or a mounted directory.
- mounts require a container run; a native (no-image) run has nothing to mount.

## Monitoring in-container execution

- `t2d_status` reports the job state and exit code.
- `t2d_logs` tails recent output; pass a `follow` window to live-sample the container or host log for a bounded number of seconds and return, which is how you watch a long task progress without blocking forever.

## Runner registration and secrets

- Key / agent auth is the normal path; it stores nothing secret.
- Password auth (`sshpass`) records only a pointer — `passwordEnv` names an environment variable, or `passwordFile` names a 0600 file — resolved at call time and never written to the ledger or returned.
- The password is consumed by the SSH layer in the moment of a call and never appears in any tool output.

## Failure translation

- No runner named X — list runners and register it; never guess a host.
- Job start failed on the runner — read the returned reason: unreachable host, auth rejected, or the container runtime (`docker`) missing. A missing docker means: pick an image-free native run or set up docker.
- `sshpass` not installed on the host — password auth cannot run; switch the runner to key auth or install sshpass.
- Job status MISSING / UNKNOWN — the container was removed or the host rebooted; re-dispatch if needed.
- Empty command — a run needs something to execute; ask the user what to send.

## Secrecy

- Never print the resolved password, `passwordEnv` values, private keys, or full secrets in replies.
- Registration shows only pointers (an env var name or a file path), which is safe to display.
- The plugin talks to the user's own servers; treat each runner as full-trust and confirm before destructive commands.

## Provenance

This plugin is MIT licensed and vendor-neutral. An earlier v0.1 targeted OpenBayes / HyperAI GraphQL; v0.2 generalizes to any SSH runner with optional Docker, and the OpenBayes-specific code was removed.
