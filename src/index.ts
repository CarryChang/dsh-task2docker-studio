/**
 * dsh-task2docker-studio Cordis plugin entry. Registers the task-to-container dispatch skill and six
 * t2d_* tools that let a weak or security-constrained host send work to external GPU/container runners
 * (OpenBayes / HyperAI Job compute). The endpoint and token come from config or the environment; the
 * access token and per-job ssh password are consumed internally and never returned to the model.
 * @module dsh-task2docker-studio
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
// Type-only: pull the ctx.skills and ctx.tools service declarations into the Context graph.
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-tools'
import { SKILL_NAME, SKILL_DESCRIPTION, SKILL_WHEN_TO_USE, SKILL_BODY } from './skill.ts'
import { createHttpTransport } from './backend/transport.ts'
import { createSshExecutor } from './backend/executor.ts'
import { Task2DockerRunner } from './backend/runner.ts'
import { Task2DockerError, type DispatchInput } from './backend/types.ts'

export const name = 'task2docker'
export const inject = ['skills', 'tools']

/** Plugin version reported in the client user-agent header. */
const VERSION = '0.1.0'

/** Deployment configuration for the plugin. */
export interface Config {
  /** GraphQL endpoint; empty means read T2D_ENDPOINT / OPENBAYES_GRAPHQL_ENDPOINT. */
  endpoint: string
  /** Access token; empty means read T2D_TOKEN / OPENBAYES_TOKEN. Never logged. */
  token: string
  /** Compute tier used when a dispatch omits resource. */
  defaultResource: string
  /** Container image used when a dispatch omits runtime. */
  defaultRuntime: string
  /** When true, dispatch requires an explicit confirm argument, gating the spend behind user agreement. */
  confirmDispatch: boolean
  /** Timeout in seconds for a single ssh exec command. */
  sshTimeoutSec: number
}

export const Config: z<Config> = z.object({
  endpoint: z.string().default(''),
  token: z.string().default(''),
  defaultResource: z.string().default(''),
  defaultRuntime: z.string().default(''),
  confirmDispatch: z.boolean().default(true),
  sshTimeoutSec: z.number().default(30),
})

/** Build a fresh, stateless runner for one call; reads credentials at call time so boot never needs them. */
function buildRunner(config: Config): Task2DockerRunner {
  const endpoint = config.endpoint || process.env['T2D_ENDPOINT'] || process.env['OPENBAYES_GRAPHQL_ENDPOINT'] || ''
  const token = config.token || process.env['T2D_TOKEN'] || process.env['OPENBAYES_TOKEN'] || ''
  const transport = createHttpTransport({ endpoint, token, userAgent: `dsh-task2docker-studio/${VERSION}` })
  return new Task2DockerRunner(transport, {
    defaultResource: config.defaultResource,
    defaultRuntime: config.defaultRuntime,
    remote: createSshExecutor(Math.max(1, config.sshTimeoutSec) * 1000),
  })
}

/** Wrap a runner call so typed user errors become ok:false results instead of crashes. */
async function guarded(run: () => Promise<unknown>): Promise<string> {
  try {
    return JSON.stringify({ ok: true, result: await run() })
  } catch (error) {
    const message = error instanceof Task2DockerError || error instanceof Error ? error.message : String(error)
    return JSON.stringify({ ok: false, error: message })
  }
}

const jsonRender = (_args: unknown, value: string) => [
  { type: 'text' as const, text: JSON.stringify(JSON.parse(value), null, 2) },
]

const STRING_PARAM = { type: 'string' } as const

/**
 * Register the dispatch methodology skill and the six task-to-container tools.
 * @param ctx - registrant context carrying the skill and tool registries.
 * @param config - deployment endpoint, credential, default and confirmation settings.
 * @returns when the plugin is ready.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  ctx.effect(() => ctx.skills.register({
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    whenToUse: SKILL_WHEN_TO_USE,
    content: SKILL_BODY,
    source: 'bundled',
    invocation: { modelInvocable: true, userInvocable: true },
  }))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 't2d_whoami',
    description:
      'Read the remote compute account once per session before dispatching: username, roles, balance, debt, '
      + 'quota minutes and how many jobs are already running. A locked account or debt must be reported to the '
      + 'user before any task is dispatched. Read-only and safe.',
    parameters: {},
    output: { schema: { type: 'string' }, render: jsonRender },
    execute: () => guarded(() => buildRunner(config).whoami()),
    presentCall: () => ({ card: 'generic', title: 'Check remote compute account', kind: 'fetch', rawInput: {} }),
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 't2d_catalog',
    description:
      'List the container images (runtimes) and compute tiers (resources) the cluster can currently boot. '
      + 'Every dispatch needs a runtime id and a resource name taken from here, never from a spoken name. '
      + 'Resources carry affordable and isFullLoad gates; a tier failing either is not runnable now. Pass device '
      + 'CPU or GPU to narrow the image list. Read-only.',
    parameters: {
      device: { ...STRING_PARAM, description: 'Narrow runtimes to a device class: "CPU" or "GPU"; omit for all.' },
    },
    output: { schema: { type: 'string' }, render: jsonRender },
    execute: args => guarded(() => buildRunner(config).catalog(args.device)),
    presentCall: args => ({
      card: 'generic',
      title: `List container images and compute tiers${args.device ? ` (${args.device})` : ''}`,
      kind: 'fetch',
      rawInput: { device: args.device ?? 'all' },
    }),
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 't2d_dispatch',
    description:
      'Send a task to an external container: create a Job and start it running remotely so this host does no compute. '
      + 'mode TASK runs a one-shot command and exits (pass command); mode WORKSPACE boots an interactive container you '
      + 'then drive with t2d_exec. runtime and resource come from t2d_catalog. Put secrets in parameters with isSecret '
      + 'true, never inside command. This spends compute: when confirmation is enabled you must pass confirm:true only '
      + 'after the user approves the restated plan.',
    parameters: {
      runtime: { ...STRING_PARAM, required: true, description: 'Container image id from t2d_catalog, e.g. "pytorch-2.11-py312-cu124".' },
      resource: { ...STRING_PARAM, required: true, description: 'Compute tier name from t2d_catalog, e.g. "a100-1".' },
      command: { ...STRING_PARAM, description: 'TASK mode: the shell command the container runs. Omit for an interactive workspace.' },
      mode: { type: 'string', enum: ['TASK', 'WORKSPACE'], description: 'TASK (default) one-shot command; WORKSPACE interactive container.' },
      name: { ...STRING_PARAM, description: 'Human name for the job and its new project.' },
      projectId: { ...STRING_PARAM, description: 'File the job under an existing project id instead of a new project.' },
      parameters: {
        type: 'array',
        description: 'Environment variables injected into the container; mark secrets with isSecret.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true, description: 'Variable name (must not start with OPENBAYES_).' },
            value: { type: 'json', required: true, description: 'A JSON string or number; no objects or arrays.' },
            isSecret: { type: 'boolean', description: 'true keeps the value env-only and redacted on read-back.' },
          },
        },
      },
      dataBindings: {
        type: 'array',
        description: 'Read-only dataset mounts as name=<owner>/<dataset>/<version>, path=/input0../input4.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true, description: 'Data reference, e.g. "<owner>/<dataset>/<version>".' },
            path: { type: 'string', required: true, description: 'Canonical mount path /input0../input4 (never /output for datasets).' },
          },
        },
      },
      confirm: { type: 'boolean', description: 'Set true only after the user approves the restated dispatch plan.' },
    },
    output: { schema: { type: 'string' }, render: jsonRender },
    execute(args) {
      if (config.confirmDispatch && !args.confirm) {
        return Promise.resolve(JSON.stringify({
          ok: false,
          error: 'Dispatch starts paid remote compute. Restate owner, mode, runtime, resource, bindings and the billing effect to the user, then re-call with confirm:true once they agree.',
        }))
      }
      const input: DispatchInput = {
        runtime: args.runtime,
        resource: args.resource,
        command: args.command,
        mode: args.mode as DispatchInput['mode'],
        name: args.name,
        projectId: args.projectId,
        parameters: args.parameters,
        dataBindings: args.dataBindings,
      }
      return guarded(() => buildRunner(config).dispatch(input))
    },
    presentCall: args => ({
      card: 'generic',
      title: `Dispatch ${args.mode ?? 'TASK'} to ${args.resource}`,
      kind: 'execute',
      rawInput: { runtime: args.runtime, resource: args.resource, mode: args.mode ?? 'TASK', hasCommand: Boolean(args.command) },
    }),
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 't2d_status',
    description:
      'Read one dispatched job: status, sub-status, chosen runtime/resource and access links. Poll until RUNNING '
      + 'before using links; ssh/service links only appear once the container is up. The ssh password is never returned, '
      + 'only reported as available. Read-only.',
    parameters: {
      jobId: { ...STRING_PARAM, required: true, description: 'Job id from t2d_dispatch or t2d_jobs.' },
    },
    output: { schema: { type: 'string' }, render: jsonRender },
    async execute(args) {
      return guarded(async () => {
        const ctxJob = await buildRunner(config).status(args.jobId)
        const { password, ...rest } = ctxJob
        return { ...rest, hasSshPassword: Boolean(password) }
      })
    },
    presentCall: args => ({ card: 'generic', title: `Status of job ${args.jobId}`, kind: 'fetch', rawInput: { jobId: args.jobId } }),
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 't2d_jobs',
    description:
      'List this account\'s own WORKSPACE and TASK jobs with id, name, mode, status, resource and links. Use it to find a '
      + 'job id or see what is already running before dispatching more. Internal sandbox jobs are excluded. Read-only.',
    parameters: {
      status: { ...STRING_PARAM, description: 'Filter to one state, e.g. "RUNNING"; omit for all.' },
    },
    output: { schema: { type: 'string' }, render: jsonRender },
    execute: args => guarded(() => buildRunner(config).listJobs(args.status)),
    presentCall: args => ({
      card: 'generic',
      title: `List jobs${args.status ? ` (${args.status})` : ''}`,
      kind: 'fetch',
      rawInput: { status: args.status ?? 'ALL' },
    }),
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 't2d_exec',
    description:
      'Run one shell command inside a RUNNING container over SSH (the data-plane for an interactive WORKSPACE, or a quick '
      + 'inspect/fetch). Resolves the ssh link and password internally; the password is consumed, never returned. Requires '
      + 'sshpass on the host. The job must be RUNNING or this fails with an actionable message.',
    parameters: {
      jobId: { ...STRING_PARAM, required: true, description: 'A RUNNING job that exposes an ssh link.' },
      command: { ...STRING_PARAM, required: true, description: 'Single shell command to run in the container.' },
    },
    output: { schema: { type: 'string' }, render: jsonRender },
    execute: args => guarded(() => buildRunner(config).exec(args.jobId, args.command)),
    presentCall: args => ({
      card: 'generic',
      title: `Run in container ${args.jobId}`,
      kind: 'execute',
      rawInput: { jobId: args.jobId, command: args.command },
    }),
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 't2d_stop',
    description:
      'Stop / cancel a running job. For a WORKSPACE this is reversible (restartable later); for a TASK it is terminal. '
      + 'Confirm with the user before stopping anything that may hold active work.',
    parameters: {
      jobId: { ...STRING_PARAM, required: true, description: 'Job id to stop.' },
    },
    output: { schema: { type: 'string' }, render: jsonRender },
    execute: args => guarded(() => buildRunner(config).stop(args.jobId)),
    presentCall: args => ({ card: 'generic', title: `Stop job ${args.jobId}`, kind: 'execute', rawInput: { jobId: args.jobId } }),
  })))
}
