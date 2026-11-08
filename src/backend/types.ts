/**
 * Shared data types and the typed user error for the task-to-docker backend. These modules are
 * deliberately free of any DeepSeek Harness import so the dispatch logic can be unit-tested and
 * reused outside a running harness. The engine is vendor-neutral: a runner is any machine the user
 * controls and can reach over SSH, with optional Docker for containerized isolation.
 * @module dsh-task2docker-studio/backend/types
 */

/** How the host authenticates to a runner over SSH. Secrets are never stored inline. */
export type AuthKind = 'key' | 'sshpass'

/**
 * A compute runner the user registers: an SSH-reachable machine. When `defaultImage` is set, runs are
 * containerized by default; otherwise commands run directly on the host.
 */
export interface Runner {
  /** Stable user-chosen handle used by every other tool. */
  name: string
  /** SSH host or IP of the server/cluster entry point. */
  host: string
  /** SSH port; defaults to 22. */
  port: number
  /** SSH user; defaults to root. */
  user: string
  /** Authentication strategy. `sshpass` needs `passwordEnv` or `passwordFile`; `key` uses the agent/keys. */
  auth: AuthKind
  /** Name of an environment variable holding the password; read at call time, never persisted. */
  passwordEnv?: string | undefined
  /** Path to a 0600 file holding the password; read at call time, never persisted. */
  passwordFile?: string | undefined
  /** Container image used when a run asks for isolation; omit to run natively. */
  defaultImage?: string | undefined
  /** Free-form tags for selection and grouping. */
  labels: string[]
}

/** A resolved SSH endpoint plus the secret the executor needs at call time. */
export interface SshTarget {
  host: string
  port: number
  user: string
  auth: AuthKind
  /** Password for `sshpass` auth; present only in the moment of a call. Never returned to the model. */
  password?: string | undefined
}

/** Whether a job runs in a container (detached) or directly on the host (backgrounded). */
export type RunMode = 'container' | 'native'

/** Lifecycle states a dispatched job can be observed in. */
export type JobState = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'STOPPED' | 'UNKNOWN'

/** The handle needed to poll, tail or stop one tracked job. */
export type JobHandle =
  | { kind: 'container'; container: string }
  | { kind: 'native'; pid: string; log: string }

/** A dispatched job, persisted in the runner's local ledger so later calls can find it by id. */
export interface JobRecord {
  id: string
  runner: string
  mode: RunMode
  /** The remote command or container launch that started it. Sensitive values are not stored here. */
  request: string
  state: JobState
  exitCode: number | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  handle: JobHandle
}

/** Result of one SSH command: captured streams and the remote exit code. */
export interface ExecResult {
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * Executes one composed remote command against a runner. The production implementation shells out to
 * `ssh` / `sshpass`; tests inject a fake so the whole engine runs offline.
 */
export interface SshClient {
  /**
   * @param target - resolved SSH endpoint (may carry an ephemeral password).
   * @param remoteCommand - a single shell command string to run on the host.
   * @returns captured stdout/stderr and the remote exit code.
   */
  run(target: SshTarget, remoteCommand: string): Promise<ExecResult>
}

/** A GraphQL-free, typed failure surfaced to the model as `ok:false`. */
export class Task2DockerError extends Error {
  /** Marks the failure as an expected, actionable condition rather than an internal crash. */
  readonly actionable = true
  /**
   * @param message - localized, actionable explanation the model can relay verbatim.
   */
  constructor(message: string) {
    super(message)
    this.name = 'Task2DockerError'
  }
}
