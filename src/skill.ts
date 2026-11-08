/**
 * Embedded task-to-docker methodology skill. The body must stay free of raw backticks: it is a
 * template literal, and inline code uses 「」 instead (a backtick truncates it with a boot-time
 * SyntaxError that tsc cannot catch).
 * @module dsh-task2docker-studio/skill
 */

export const SKILL_NAME = 'task2docker-studio'
export const SKILL_DESCRIPTION = 'Offload compute from a weak or security-constrained host onto external GPU/container runners. Send a task command to a remote container, poll it, run one-off commands over SSH, and stop it — the host stays a controller.'
export const SKILL_WHEN_TO_USE = 'The user wants work to run somewhere other than this machine: 把任务丢到容器/集群, 本机跑不动想借用 GPU/算力, 需要在隔离容器里安全地跑一段命令/训练/批处理, run this remotely, use a cluster, dispatch to a container. Powered by OpenBayes / HyperAI job compute.'

export const SKILL_BODY = `# Task-to-Docker: dispatch work to external containers

You are a controller. The host does not run the workload; a remote container does. Your job is to
choose the right runner, send the task, watch it, and bring results back. Confirm before you spend.

## When this applies

- The host is weaker than the target: a model will not fit, a build is too slow, a batch job is too big.
- Safety isolation: untrusted or experimental code should run in a throwaway container, not on the host.
- Access to hardware the host lacks: a specific GPU tier, RDMA, or a prebuilt image.

## Fixed call order

1. 「t2d_whoami」 once per session. Read balance, debt, quota minutes, limitations, and running-job count.
   A locked account or positive debt means tell the user before any dispatch.
2. 「t2d_catalog」 to list container images (runtimes) and compute tiers (resources). Pick the runtime id
   and resource name from the catalog, never from a name the user said out loud. Resources carry
   affordable and isFullLoad gates; a tier that fails either is not runnable now.
3. 「t2d_dispatch」 to send the task. For a one-shot job use mode TASK with the command; for an
   interactive environment use mode WORKSPACE. Restate the final config and its billing effect and get
   an explicit yes before you dispatch — this is a confirm-tier write even when the user named the tier.
4. 「t2d_status」 until the job reaches RUNNING. A fresh job has no ssh or service links; links appear
   only once it is up. Do not hand-build a URL from job id and port; read links from the response.
5. Optional 「t2d_exec」 for a one-off command in a RUNNING container over SSH, or to pull a small
   artifact. For a real training run prefer baking the whole command into a TASK dispatch.
6. 「t2d_stop」 when done or when the user asks to cancel. Tasks are terminal once stopped; workspaces
   can be restarted.

## Task vs workspace

- TASK is the canonical "send a task, get a result" shape: pass command and the container runs it and exits.
  Put secrets in parameters with isSecret true, never inside the command string.
- WORKSPACE is an interactive container you then drive with t2d_exec or hand SSH/Jupyter links to the user.

## Storage and paths (inside the container)

- /output persists across restarts and is the working directory; write code and artifacts there.
- /input0 through /input4 are read-only dataset mounts; bind large inputs there, never at /output.
- Everything outside /output and /input is the system disk and is lost on restart; apt installs do not persist.
- To persist Python deps use pip install --user (lands in /output/.pylibs on both Conda and uv runtimes).

## Confirmation and safety

- Dispatch is a confirm-tier action: always restate owner, project, mode, runtime, resource, bindings,
  and the billing assumption, then wait for yes.
- Never bind an external dataset to /output — it shadows the workspace working directory.
- Never dispatch VM, batch, or sandbox modes; only TASK and WORKSPACE are supported. Sandbox is internal.
- Reading status, catalog, and whoami is always safe and needs no confirmation.

## Failure translation

- No ssh link yet — the job is not RUNNING; keep polling t2d_status instead of guessing a host.
- Resource not affordable or isFullLoad — pick another tier or tell the user capacity is taken.
- Quota exhausted but balance is positive — subscription minutes are used, pay-as-you-go may still run.
- GraphQL returned null with no error — the write did not take effect; do not retry with guessed parameters.
- sshpass missing on the host — t2d_exec cannot use password auth; install sshpass, add a key, or dispatch
  the command through a TASK job instead.

## Secrecy

- Never print the access token, the job ssh/Jupyter password, or Secret parameter values in replies.
- t2d_exec resolves the password internally from the job context; it is consumed, never returned.
`
