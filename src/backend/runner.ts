/**
 * Task-to-docker orchestration over the injected GraphQL transport and remote executor. Every
 * method returns typed DTOs; the plugin entry wraps them into `ok`/`error` JSON for the model.
 * The runner is transport-agnostic so the whole dispatch flow is unit-testable with a fake.
 * @module dsh-task2docker-studio/backend/runner
 */

import {
  WHOAMI, RUNTIME_CATALOG, RESOURCE_CATALOG, CREATE_JOB, LOAD_JOB_CONTEXT, LOAD_MY_JOBS, STOP_JOB,
  buildCreateJobVariables, runtimeId,
} from './operations.ts'
import { requireField } from './transport.ts'
import { parseSshLink } from './ssh.ts'
import { Task2DockerError } from './types.ts'
import type {
  DispatchInput, DispatchResult, ExecResult, GraphQLTransport, JobContext, JobLink, JobRow,
  JobStatus, ResourceRow, RuntimeRow, WhoamiResult,
} from './types.ts'

/** Executes one shell command inside a RUNNING container given its resolved ssh endpoint and secret. */
export type RemoteExecutor = (args: { host: string; port: number; user: string; password: string; command: string }) => Promise<ExecResult>

/** Deployment defaults and seams injected into the runner. */
export interface RunnerOptions {
  /** Default compute tier when a dispatch omits `resource`. */
  defaultResource: string
  /** Default container image when a dispatch omits `runtime`. */
  defaultRuntime: string
  /** Remote command executor for the `exec` data-plane; absent disables `exec`. */
  remote?: RemoteExecutor
  /** Account override; when set, used instead of the whoami `username`. */
  userId?: string
}

interface MePayload {
  username?: string
  displayName?: string
  roles?: string[]
  locked?: boolean
  account?: { balance?: { amount?: string; currency?: string }; debtMoney?: { amount?: string; currency?: string } }
  quota?: {
    storageQuota?: { remainMegaBytes?: number }
    computationQuota?: Array<{ key?: string; value?: { availableMinutes?: number } }>
  }
  jobs?: { pageInfo?: { total?: number } }
}

interface RuntimeRowRaw { name?: string; framework?: string; version?: string; device?: string; deprecated?: boolean; labels?: string[] }
interface ResourceRowRaw { name?: string; verboseName?: string; gpuResource?: string; affordable?: boolean; isFullLoad?: boolean; gpu?: Array<{ name?: string; count?: number }> }
interface JobRaw {
  id?: string; name?: string; mode?: string; status?: JobStatus; subStatus?: string | null
  startedAt?: string | null; endAt?: string | null; canStop?: boolean; password?: string | null
  resource?: { name?: string }; runtime?: { framework?: string; version?: string }
  links?: JobLink[]
}

/**
 * Read a job's account-scoped identity, catalog options, dispatch tasks to containers, poll status,
 * run one-off commands, and stop jobs. The host never computes; it only controls.
 */
export class Task2DockerRunner {
  private username: string | null = null

  /**
   * @param transport - GraphQL executor (HTTP in production, fake in tests).
   * @param options - deployment defaults and the remote executor seam.
   */
  constructor(private readonly transport: GraphQLTransport, private readonly options: RunnerOptions) {}

  /** Bootstrap: identity, balance, quota and active-job count, cached for later account-scoped calls. */
  async whoami(): Promise<WhoamiResult> {
    const data = await this.transport.execute<{ me: MePayload | null }>(WHOAMI)
    const me = requireField<MePayload>(data as unknown as Record<string, unknown>, 'me')
    const username = me.username
    if (!username) {
      throw new Task2DockerError('The platform returned an identity with no username; the token may be for an org service account. Set userId in config.')
    }
    this.username = username
    const computation = me.quota?.computationQuota?.[0]?.value?.availableMinutes ?? null
    return {
      username,
      displayName: me.displayName ?? username,
      roles: me.roles ?? [],
      locked: me.locked ?? false,
      balance: formatMoney(me.account?.balance),
      debt: formatMoney(me.account?.debtMoney),
      availableMinutes: computation,
      storageRemainMB: me.quota?.storageQuota?.remainMegaBytes ?? null,
      activeJobs: me.jobs?.pageInfo?.total ?? 0,
      endpoint: 'current',
    }
  }

  /** Resolve the account id to use: explicit config, cached whoami, or a fresh whoami. */
  private async resolveUserId(): Promise<string> {
    if (this.options.userId) return this.options.userId
    if (this.username) return this.username
    const info = await this.whoami()
    return info.username
  }

  /** List available container images and compute tiers with their create gates. */
  async catalog(device?: string): Promise<{ runtimes: RuntimeRow[]; resources: ResourceRow[] }> {
    const [runtimeData, resourceData] = await Promise.all([
      this.transport.execute<{ normalClusterRuntimes: RuntimeRowRaw[] | null }>(RUNTIME_CATALOG, { runtimeType: ['CONTAINER'], labels: [] }),
      this.transport.execute<{ normalClusterResources: ResourceRowRaw[] | null }>(RESOURCE_CATALOG, { labels: ['MACHINE_LEARNING'] }),
    ])
    let runtimes = (runtimeData.normalClusterRuntimes ?? []).map(r => ({
      id: runtimeId(r.framework ?? '', r.version ?? ''),
      framework: r.framework ?? '',
      version: r.version ?? '',
      device: r.device ?? 'GPU',
      deprecated: r.deprecated ?? false,
      labels: r.labels ?? [],
    }))
    if (device === 'CPU' || device === 'GPU') {
      runtimes = runtimes.filter(r => r.device === device)
    }
    const resources = (resourceData.normalClusterResources ?? []).map(r => ({
      name: r.name ?? '',
      verboseName: r.verboseName ?? r.name ?? '',
      gpuResource: r.gpuResource ?? 'CPU',
      affordable: r.affordable ?? false,
      isFullLoad: r.isFullLoad ?? false,
      gpuSummary: summarizeGpu(r.gpu),
    }))
    return { runtimes, resources }
  }

  /**
   * Send one task to an external container. Builds a validated `CreateJobInput` (mode-gated,
   * string runtime/resource, canonical bindings) and files the job under the resolved account.
   * @param input - dispatch slots; runtime/resource fall back to configured defaults.
   * @returns the created job summary for status polling.
   */
  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    const userId = await this.resolveUserId()
    const variables = buildCreateJobVariables(userId, input, {
      runtime: this.options.defaultRuntime,
      resource: this.options.defaultResource,
    })
    const data = await this.transport.execute<{ createJob: JobRaw | null }>(CREATE_JOB, variables)
    const job = requireField<JobRaw>(data as unknown as Record<string, unknown>, 'createJob')
    return toDispatch(job)
  }

  /** Read one job's full context; use this to wait for RUNNING before exec or link use. */
  async status(jobId: string): Promise<JobContext> {
    const userId = await this.resolveUserId()
    const data = await this.transport.execute<{ job: JobRaw | null }>(LOAD_JOB_CONTEXT, { userId, jobId })
    const job = requireField<JobRaw>(data as unknown as Record<string, unknown>, 'job')
    return {
      jobId: job.id ?? jobId,
      name: job.name ?? '',
      mode: job.mode ?? '',
      status: job.status ?? 'CREATED',
      subStatus: job.subStatus ?? null,
      resource: job.resource?.name ?? '',
      runtime: runtimeId(job.runtime?.framework ?? '', job.runtime?.version ?? ''),
      startedAt: job.startedAt ?? null,
      endAt: job.endAt ?? null,
      canStop: job.canStop ?? false,
      links: job.links ?? [],
      password: job.password ?? null,
    }
  }

  /** List the caller's own WORKSPACE and TASK jobs; internal SANDBOX jobs are excluded by the query. */
  async listJobs(status?: string): Promise<JobRow[]> {
    const userId = await this.resolveUserId()
    const data = await this.transport.execute<{ party: { jobs?: { data?: JobRaw[] } } | null }>(
      LOAD_MY_JOBS,
      { username: userId, status: status ? [status] : ['ALL'] },
    )
    const party = requireField<{ jobs?: { data?: JobRaw[] } }>(data as unknown as Record<string, unknown>, 'party')
    return (party.jobs?.data ?? []).map(j => ({
      id: j.id ?? '',
      name: j.name ?? '',
      mode: j.mode ?? '',
      status: j.status ?? 'CREATED',
      resource: j.resource?.name ?? '',
      runtime: runtimeId(j.runtime?.framework ?? '', j.runtime?.version ?? ''),
      links: j.links ?? [],
    }))
  }

  /** Stop / cancel a running job. Reversible for workspaces; terminal for tasks. */
  async stop(jobId: string): Promise<{ jobId: string; status: JobStatus; cancellingAt: string | null }> {
    const userId = await this.resolveUserId()
    const data = await this.transport.execute<{ stopJob: JobRaw | null }>(STOP_JOB, { userId, jobId })
    const job = requireField<JobRaw>(data as unknown as Record<string, unknown>, 'stopJob')
    return { jobId: job.id ?? jobId, status: job.status ?? 'CANCELLING', cancellingAt: null }
  }

  /**
   * Run one command inside a RUNNING container over SSH. Resolves the ssh link and secret from the
   * job context, then delegates to the injected remote executor. Password never appears in the result.
   * @param jobId - a RUNNING WORKSPACE or TASK job exposing `links.ssh`.
   * @param command - single shell command to run in the container.
   * @returns the captured stdout/stderr and exit code.
   */
  async exec(jobId: string, command: string): Promise<ExecResult> {
    if (!this.options.remote) {
      throw new Task2DockerError('Remote exec is not available in this deployment (no ssh executor configured). Use t2d_dispatch with a command instead.')
    }
    const ctx = await this.status(jobId)
    if (ctx.status !== 'RUNNING') {
      throw new Task2DockerError(`Job ${jobId} is ${ctx.status}, not RUNNING; commands can only run once the container is up.`)
    }
    if (!ctx.password) {
      throw new Task2DockerError(`Job ${jobId} returned no ssh password; the account may not own it. Confirm the job id.`)
    }
    const target = parseSshLink(ctx.links)
    return this.options.remote({ ...target, password: ctx.password, command })
  }
}

function formatMoney(money?: { amount?: string; currency?: string }): string {
  if (!money?.amount) return '0'
  return `${money.amount} ${money.currency ?? ''}`.trim()
}

function summarizeGpu(gpu?: Array<{ name?: string; count?: number }>): string {
  if (!gpu?.length) return 'CPU only'
  return gpu.map(g => `${g.count ?? 1}x ${g.name ?? 'gpu'}`).join(', ')
}

function toDispatch(job: JobRaw): DispatchResult {
  return {
    jobId: job.id ?? '',
    name: job.name ?? '',
    mode: job.mode ?? '',
    status: job.status ?? 'CREATED',
    resource: job.resource?.name ?? '',
    runtime: runtimeId(job.runtime?.framework ?? '', job.runtime?.version ?? ''),
    links: job.links ?? [],
  }
}
