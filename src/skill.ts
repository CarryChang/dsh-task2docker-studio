/**
 * Embedded task-to-runner dispatch methodology. The body must stay free of raw backticks: it is a
 * template literal, and inline code uses 「」 instead (a backtick truncates it with a boot-time
 * SyntaxError that tsc cannot catch).
 * @module dsh-task2docker-studio/skill
 */

export const SKILL_NAME = 'task2docker-studio'
export const SKILL_DESCRIPTION = 'Offload compute from a weak or security-constrained host onto your own registered servers and containers. Register any SSH-reachable runner, then dispatch a command to it (in a Docker container for isolation, or natively on the host), follow its status, tail its logs, and stop it. Vendor-neutral: a cloud server you can ssh into is enough.'
export const SKILL_WHEN_TO_USE = 'The user wants work to run somewhere other than this machine on a server they control: 把任务丢到我的服务器/容器跑, 本机跑不动想借用别的机器/GPU, 在隔离容器里安全地跑一段命令/训练/批处理, run this on my cloud server / another host / a container, dispatch to a remote box. Not tied to any specific vendor.'

export const SKILL_BODY = `# Task-to-Docker: dispatch work to your own runners

You are a controller. The host does not run the workload; a runner the user registered does. A runner
is any machine reachable over SSH — a cloud server, a GPU box, a cluster entry node. Choose where the
work runs, start it, watch it, stop it. Confirm before you start anything heavy.

## When this applies

- The host is weaker than the target: a model will not fit, a build is too slow, a batch job is too big.
- Safety isolation: untrusted or experimental code should run in a throwaway container, not on the host.
- The user has their own server and just wants tasks sent to it.

## Fixed call order

1. 「t2d_list_runners」 to see what is already registered. If none, ask the user for the server and use
   「t2d_register_runner」 to add it: name, host, optional port (22) and user (root), auth key or sshpass,
   and optionally a defaultImage so later runs containerize automatically.
2. 「t2d_run」 to dispatch one command to a named runner. It starts and tracks a job and returns a job id.
   With an image (per-call or the runner default) it runs as a detached container; without one it runs
   backgrounded on the host. Restate what will run where, and the resource cost, before a heavy run.
3. 「t2d_status」 with the job id to observe RUNNING / SUCCEEDED / FAILED / STOPPED and the exit code.
4. 「t2d_logs」 for the last lines of output when you need to show or diagnose results.
5. 「t2d_stop」 to cancel a job the user no longer wants running.
6. 「t2d_remove_runner」 only when the user asks to forget a server.

## Container vs native

- Container is the default when an image exists: isolation, a clean filesystem, no leftover host state.
  This is the recommended path for untrusted or experimental work.
- Native (「t2d_run」 with native true, or a runner with no image) runs the command directly on the host,
  backgrounded with a log file. Use it when the work must touch host state or no container runtime is set up.

## Runner registration and secrets

- Key / agent auth is the normal path; it stores nothing secret.
- Password auth (sshpass) records only a pointer — 「passwordEnv」 names an environment variable, or
  「passwordFile」 names a 0600 file — resolved at call time and never written to the ledger or returned.
- The password is consumed by the SSH layer in the moment of a call and never appears in any tool output.

## Failure translation

- No runner named X — list runners and register it; never guess a host.
- Job start failed on the runner — read the returned reason: unreachable host, auth rejected, or the
  container runtime (「docker」) missing. A missing docker means: pick an image-free native run or set up docker.
- sshpass not installed on the host — password auth cannot run; switch the runner to key auth or install sshpass.
- Job status MISSING / UNKNOWN — the container was removed or the host rebooted; re-dispatch if needed.
- Empty command — a run needs something to execute; ask the user what to send.

## Secrecy

- Never print the resolved password, passwordEnv values, private keys, or full secrets in replies.
- Registration shows only pointers (an env var name or a file path), which is safe to display.
- The plugin talks to the user's own servers; treat each runner as full-trust and confirm before destructive commands.
`
