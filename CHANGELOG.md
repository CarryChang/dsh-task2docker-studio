# Changelog

All notable changes to this project follow the plugin's own versioning.

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
