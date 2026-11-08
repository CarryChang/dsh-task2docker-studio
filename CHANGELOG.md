# Changelog

All notable changes to this project follow the plugin's own versioning.

## 0.5.0

File transfer and log-based monitoring of in-container tasks.

- **New tools** `t2d_copy_to` (scp push a file/dir to a runner, recursive) and `t2d_copy_from` (pull
  artifacts back), so users can send local code, data or a skill to a server and retrieve results.
- **Container mounts on `t2d_run`**: a `mounts` list maps host paths to container paths (optionally
  read-only). The normal flow is copy_to a host directory, then run with that path mounted into the
  container; native runs reject mounts because there is nothing to bind.
- **Log follow for monitoring**: `t2d_logs` gains a `follow` window that live-samples the container or
  native log for a bounded number of seconds then returns, so watching a long task does not block.
- **sshpass correctness**: password-auth ssh/scp no longer pass `BatchMode=yes`, which would disable the
  very password prompt sshpass relies on; key auth keeps BatchMode.
- `SshClient` gained `copyTo` / `copyFrom`; the engine, skill, READMEs and the portable Agent-Skill CLI
  all cover the new transfer / mount / follow surface.

## 0.2.0

De-vendored: the tool no longer targets OpenBayes / HyperAI. A runner is now any SSH-reachable machine
the user controls, with optional Docker for isolation. Also ships as a standalone general Agent Skill.

- **Removed** the OpenBayes GraphQL control plane (`transport.ts`, `operations.ts`, the GraphQL-shaped
  `runner.ts`/`executor.ts`). No vendor SDK remains in the backend.
- **New generic engine**: `src/backend/{types,ssh,registry,engine}.ts`. Register runners, dispatch a
  command as a detached Docker container or backgrounded natively over SSH, then poll status, tail logs
  and stop. Runner + job ledger persist as JSON under `stateDir` (default `~/.dsh-task2docker`).
- **New tool set** replaces the vendor tools: `t2d_register_runner`, `t2d_list_runners`,
  `t2d_remove_runner`, `t2d_run`, `t2d_status`, `t2d_logs`, `t2d_stop`.
- **Credential pointers, not secrets**: password auth records only `passwordEnv` / `passwordFile`,
  resolved at call time and never stored or returned; key/agent auth stores nothing secret.
- **Config** now `stateDir`, `sshTimeoutSec`, and an optional `runners` preload list registered on load.
- **General Agent Skill**: `skills/dsh-task2docker-studio/` (open format) with a stdlib-only
  `scripts/t2d.mjs` CLI and a committed `scripts/lib/` runtime derived from the DSH-free backend by
  `scripts/build-portable.mjs`, so it installs into Claude Code / Cursor / Copilot with no build.
- Skill body and READMEs rewritten vendor-neutral; offline smoke covers the full runner flow.

## 0.1.0

Initial release: a DeepSeek Harness plugin that offloads compute from a weak or
security-constrained host onto external GPU/container runners (OpenBayes /
HyperAI job compute).

- Cordis TS package plugin with a `dsh.bundle` manifest and `cordis.patch.yml`.
- Bundled `task2docker-studio` methodology skill: whoami → catalog → dispatch →
  status → exec → stop, with confirm-before-spend and container path rules.
- Seven typed `t2d_*` tools:
  - `t2d_whoami` — account identity, balance, debt, quota, active-job count.
  - `t2d_catalog` — container images (runtimes) and compute tiers (resources) with affordability/full-load gates and an optional CPU/GPU filter.
  - `t2d_dispatch` — create a `TASK` (one-shot command) or `WORKSPACE` job on the remote cluster; mode-gated to TASK/WORKSPACE only, canonical dataset bindings, secret-safe parameters, and a `confirm` gate behind `confirmDispatch`.
  - `t2d_status` — poll a job; the ssh password is redacted and reported as availability only.
  - `t2d_jobs` — list the account's own WORKSPACE/TASK jobs (internal sandbox jobs excluded).
  - `t2d_exec` — run one command inside a RUNNING container over SSH via an injected executor.
  - `t2d_stop` — stop / cancel a job.
- DSH-free backend (transport / operations / runner / ssh / executor) so the
  dispatch logic is unit-testable offline; `index.ts` is the only Cordis-facing layer.
- Deterministic offline smoke covering payload assembly, mode gating, catalog
  mapping, ssh-link parsing, status/exec flow, and skill boot safety.
