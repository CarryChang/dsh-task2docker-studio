/**
 * GraphQL operation documents and the create-job payload builder. The documents are the executable
 * templates carried over from the openbayes-user skill (trimmed to the fields the task-to-docker
 * flow consumes); the builder encodes the platform's string-typed `runtime`/`resource` rule and the
 * mode → sub-input pairing so a dispatch never discovers the shape by reading a validation error.
 * @module dsh-task2docker-studio/backend/operations
 */

import { Task2DockerError, type DispatchInput, type SupportedMode } from './types.ts'

/** Identity, balance, quota, limitations and active-job count. */
export const WHOAMI = `query Whoami {
  me {
    id
    username
    displayName
    roles
    locked
    account { balance { amount currency } debtMoney { amount currency } }
    quota {
      storageQuota { remainMegaBytes }
      computationQuota { key value { availableMinutes } }
    }
    jobs(page: 1, status: [RUNNING, CREATED]) { pageInfo { total } }
  }
}`

/** Container images the cluster can boot; `runtimeType` filters to CONTAINER workloads. */
export const RUNTIME_CATALOG = `query JobRuntimes($runtimeType: [RuntimeType], $labels: [String!]) {
  normalClusterRuntimes(runtimeType: $runtimeType, labels: $labels) {
    name
    framework
    version
    device
    deprecated
    labels
  }
}`

/** Compute tiers with the affordability and full-load gates a create must pass. */
export const RESOURCE_CATALOG = `query LoadResources($labels: [String]) {
  normalClusterResources(labels: $labels) {
    name
    verboseName
    gpuResource
    affordable
    isFullLoad
    gpu { name count }
  }
}`

/** Create one job (TASK or WORKSPACE) from a validated `CreateJobInput`. */
export const CREATE_JOB = `mutation CreateJob($userId: String!, $input: CreateJobInput) {
  createJob(userId: $userId, input: $input) {
    id
    name
    mode
    status
    subStatus
    resource { name }
    runtime { framework version }
    links { name value }
  }
}`

/** Full context of one job for status polling and exec-target resolution. */
export const LOAD_JOB_CONTEXT = `query LoadJobContext($userId: String!, $jobId: String!) {
  job(userId: $userId, jobId: $jobId) {
    id
    name
    mode
    status
    subStatus
    startedAt
    endAt
    canStop
    resource { name }
    runtime { framework version }
    links { name value }
    password
  }
}`

/** List the caller's own jobs; SANDBOX and internal modes are excluded server-side by `modes`. */
export const LOAD_MY_JOBS = `query LoadMyJobs($username: ID!, $status: [JobStatusInput] = [ALL], $page: Int = 1) {
  party(id: $username) {
    jobs(page: $page, status: $status, modes: [WORKSPACE, TASK]) {
      data {
        id
        name
        mode
        status
        resource { name }
        runtime { framework version }
        links { name value }
      }
      pageInfo { total current next prev }
    }
  }
}`

/** Stop / cancel a running job. */
export const STOP_JOB = `mutation StopJob($userId: String!, $jobId: String!) {
  stopJob(userId: $userId, jobId: $jobId) {
    id
    name
    status
    cancellingAt
  }
}`

/** Reserved environment-variable prefix the platform rejects for custom variables. */
const RESERVED_PARAM_PREFIX = 'OPENBAYES_'

/**
 * Join a runtime's framework and version into the string identifier a create payload expects.
 * The version already encodes OS / python / cuda; `device` filters the catalog and never enters the id.
 * @param framework - runtime framework, e.g. `pytorch`.
 * @param version - runtime version, e.g. `2.11-py312-cu124`.
 * @returns `<framework>-<version>`.
 */
export function runtimeId(framework: string, version: string): string {
  return `${framework}-${version}`
}

/**
 * Reject modes outside TASK / WORKSPACE and normalize the payload into a `CreateJobInput`.
 * Secrets stay flagged so the read side can redact them; reserved parameter names fail fast.
 * @param userId - owning username (or org slug) the job is filed under.
 * @param input - dispatch request slots.
 * @param defaults - deployment defaults for runtime and resource when the caller omits them.
 * @returns `{ userId, input }` variables for the CREATE_JOB mutation.
 */
export function buildCreateJobVariables(
  userId: string,
  input: DispatchInput,
  defaults: { runtime: string; resource: string },
): { userId: string; input: Record<string, unknown> } {
  const mode: SupportedMode = input.mode ?? 'TASK'
  if (mode !== 'TASK' && mode !== 'WORKSPACE') {
    throw new Task2DockerError(
      `Only TASK and WORKSPACE can be dispatched. "${String(mode)}" (VM, batch, sandbox) is internal or unsupported; it is never created on a user's behalf.`,
    )
  }
  const runtime = input.runtime || defaults.runtime
  const resource = input.resource || defaults.resource
  if (!runtime) {
    throw new Task2DockerError('No runtime selected and no default configured. Call t2d_catalog and pass a runtime id.')
  }
  if (!resource) {
    throw new Task2DockerError('No resource selected and no default configured. Call t2d_catalog and pass a resource name.')
  }

  const createInput: Record<string, unknown> = { mode, runtime, resource }
  if (mode === 'TASK') {
    createInput.newTask = input.command ? { command: input.command } : {}
  } else {
    createInput.newWorkspace = {}
  }
  if (input.projectId) createInput.projectId = input.projectId
  if (input.name) createInput.projectName = input.name

  if (input.parameters?.length) {
    createInput.parameters = input.parameters.map(p => {
      if (p.name.startsWith(RESERVED_PARAM_PREFIX)) {
        throw new Task2DockerError(`Parameter "${p.name}" uses the reserved ${RESERVED_PARAM_PREFIX} prefix; rename it.`)
      }
      if (typeof p.value !== 'number' && typeof p.value !== 'string') {
        throw new Task2DockerError(`Parameter "${p.name}" value must be a number or string; the platform rejects nested objects and arrays.`)
      }
      const entry: Record<string, unknown> = { name: p.name, value: p.value }
      if (p.isSecret) entry.isSecret = true
      return entry
    })
  }

  if (input.dataBindings?.length) {
    createInput.dataBindings = input.dataBindings.map(b => {
      const path = b.path
      if (!/^\/(output|input[0-4])$/.test(path)) {
        throw new Task2DockerError(`Binding path "${path}" must be a canonical /output or /input0../input4 mount path.`)
      }
      const bindingType = b.bindingType ?? 'DATASET'
      if (bindingType === 'DATASET' && path === '/output') {
        throw new Task2DockerError('A dataset must never mount at /output; it shadows the workspace working directory. Use /input0../input4 for datasets.')
      }
      return {
        name: b.name,
        path,
        bindingType,
        bindingAuth: b.bindingAuth ?? 'READ_ONLY',
      }
    })
  }

  return { userId, input: createInput }
}
