/**
 * Shared data types and the typed user error for the task-to-docker backend. These modules are
 * deliberately free of any DeepSeek Harness import so the dispatch logic can be unit-tested and
 * reused outside a running harness.
 * @module dsh-task2docker-studio/backend/types
 */

/** The only two job modes this plugin will create. Sandbox / VM / batch modes are platform internals and are never dispatched on a user's behalf. */
export type SupportedMode = 'TASK' | 'WORKSPACE'

/** Terminal and in-flight job states returned by the platform (`Job.status`). */
export type JobStatus =
  | 'QUEUED'
  | 'CREATED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'CANCELLED'
  | 'FAILED'
  | 'CANCELLING'

/** A GraphQL failure, or a client-side misconfiguration, surfaced to the model as `ok:false`. */
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

/** One name/value link on a job (ssh, workspace, auxiliary, frontend, sandbox). */
export interface JobLink {
  name: string
  value: string
}

/** Account context read once per session before any dispatch (`t2d_whoami`). */
export interface WhoamiResult {
  username: string
  displayName: string
  roles: string[]
  locked: boolean
  balance: string
  debt: string
  /** Free compute minutes on the subscription quota, when present. */
  availableMinutes: number | null
  storageRemainMB: number | null
  /** Count of jobs currently RUNNING or CREATED. */
  activeJobs: number
  endpoint: string
}

/** A container image the cluster can boot (`normalClusterRuntimes`). */
export interface RuntimeRow {
  /** `framework`+`version` joined into the `runtime` string a create payload expects. */
  id: string
  framework: string
  version: string
  device: string
  deprecated: boolean
  labels: string[]
}

/** A compute tier the cluster offers (`normalClusterResources`). */
export interface ResourceRow {
  name: string
  verboseName: string
  gpuResource: string
  /** Whether the user can pay for it under current balance/quota. */
  affordable: boolean
  /** Whether the tier is currently full cluster-wide. */
  isFullLoad: boolean
  gpuSummary: string
}

/** Parameters for `t2d_dispatch`: send one task to an external container. */
export interface DispatchInput {
  /** Shell command the container runs as the task; omitted means an interactive task with no startup command. */
  command?: string | undefined
  /** Container image id, e.g. `pytorch-2.11-py312-cu124`. */
  runtime: string
  /** Compute tier name, e.g. `a100-1`. */
  resource: string
  /** Defaults to TASK; WORKSPACE is kept for interactive takeover. */
  mode?: SupportedMode | undefined
  /** Existing project to file the job under. */
  projectId?: string | undefined
  /** Human name for the job/project. */
  name?: string | undefined
  /** Environment variables; secrets must be flagged so they never echo back. `value` is validated to be a number or string. */
  parameters?: Array<{ name: string; value: unknown; isSecret?: boolean | undefined }> | undefined
  /** Read-only dataset mounts as `<owner>/<dataset>/<version>` -> `/input{N}`. */
  dataBindings?: Array<{ name: string; path: string; bindingType?: 'DATASET' | 'OUTPUT'; bindingAuth?: 'READ_ONLY' | 'READ_WRITE' }> | undefined
}

/** Result of a dispatch: enough to poll and reach the container. */
export interface DispatchResult {
  jobId: string
  name: string
  mode: string
  status: JobStatus
  resource: string
  runtime: string
  links: JobLink[]
}

/** Full job view for status polling and exec-target resolution (`load-job-context`). */
export interface JobContext {
  jobId: string
  name: string
  mode: string
  status: JobStatus
  subStatus: string | null
  resource: string
  runtime: string
  startedAt: string | null
  endAt: string | null
  canStop: boolean
  links: JobLink[]
  /** SSH/Jupyter shared secret. Sensitive; the tools redact it from listings and only expose it to the exec path. */
  password: string | null
}

/** A row from `t2d_jobs` listing. */
export interface JobRow {
  id: string
  name: string
  mode: string
  status: JobStatus
  resource: string
  runtime: string
  links: JobLink[]
}

/** Parsed SSH endpoint from `links.ssh` (`ssh root@<host> -p<port>`). */
export interface SshTarget {
  host: string
  port: number
  user: string
}

/** Outcome of a one-off command run inside the container. */
export interface ExecResult {
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
}

/** A minimal GraphQL executor, injected so the runner is testable without a live platform. */
export interface GraphQLTransport {
  /**
   * Run one operation and return the bare `data` object.
   * @param query - GraphQL document.
   * @param variables - operation variables.
   * @returns the `data` payload; rejects on HTTP or GraphQL `errors`.
   */
  execute<T>(query: string, variables?: Record<string, unknown>): Promise<T>
}
