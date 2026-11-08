/**
 * dsh-task2docker-studio Cordis plugin entry. Registers the task-to-runner dispatch methodology skill
 * and seven vendor-neutral t2d_* tools: register / list / remove an SSH-reachable runner, run a command
 * on it (Docker container or native), then poll status, tail logs and stop. Credentials are pointers
 * only (an env var name or a 0600 file path) and the resolved password never reaches tool output.
 * @module dsh-task2docker-studio
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
// Type-only: pull the ctx.skills and ctx.tools service declarations into the Context graph.
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-tools'
import { SKILL_NAME, SKILL_DESCRIPTION, SKILL_WHEN_TO_USE, SKILL_BODY } from './skill.ts'
import { createSshClient } from './backend/ssh.ts'
import { Store } from './backend/registry.ts'
import { Task2DockerEngine } from './backend/engine.ts'
import { Task2DockerError, type Runner } from './backend/types.ts'
import type { ContainerMount } from './backend/types.ts'
import type { RunnerInput } from './backend/registry.ts'

export const name = 'task2docker'
export const inject = ['skills', 'tools']

/** One preloaded runner supplied through cordis.yml; empty optional fields mean "use the default". */
export interface PreloadRunner {
  name: string
  host: string
  port: number
  user: string
  auth: string
  passwordEnv: string
  passwordFile: string
  defaultImage: string
  labels: string[]
}

/** Deployment configuration for the plugin. */
export interface Config {
  /** Directory holding runners.json and jobs.json; empty means ~/.dsh-task2docker. */
  stateDir: string
  /** Per-command SSH timeout in seconds. */
  sshTimeoutSec: number
  /** Runners registered on load, so a profile ships ready-to-use servers without a manual step. */
  runners: PreloadRunner[]
}

export const Config: z<Config> = z.object({
  stateDir: z.string().default(''),
  sshTimeoutSec: z.number().default(60),
  runners: z.array(z.object({
    name: z.string(),
    host: z.string(),
    port: z.number().default(22),
    user: z.string().default('root'),
    auth: z.string().default('key'),
    passwordEnv: z.string().default(''),
    passwordFile: z.string().default(''),
    defaultImage: z.string().default(''),
    labels: z.array(z.string()).default([]),
  })).default([]),
})

/** Build a fresh engine bound to the configured state directory and SSH timeout. */
function buildEngine(config: Config): Task2DockerEngine {
  const stateDir = config.stateDir || join(homedir(), '.dsh-task2docker')
  const ssh = createSshClient(Math.max(1, config.sshTimeoutSec) * 1000)
  return new Task2DockerEngine(new Store(stateDir), ssh)
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.length ? value : undefined
}

/** Wrap an engine call so typed user errors become ok:false results instead of crashes. */
async function guarded(run: () => Promise<unknown> | unknown): Promise<string> {
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
 * Register the methodology skill, the seven task-to-runner tools, and any preloaded runners.
 * @param ctx - registrant context carrying the skill and tool registries.
 * @param config - state directory, SSH timeout and preloaded runners.
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

  // Seed preloaded runners on load so a profile is usable without a manual register step.
  const engine = buildEngine(config)
  for (const r of config.runners) {
    const input: RunnerInput = {
      name: r.name,
      host: r.host,
      port: r.port,
      user: r.user,
      auth: (r.auth === 'sshpass' ? 'sshpass' : 'key'),
      passwordEnv: emptyToUndefined(r.passwordEnv),
      passwordFile: emptyToUndefined(r.passwordFile),
      defaultImage: emptyToUndefined(r.defaultImage),
      labels: r.labels,
    }
    engine.registerRunner(input)
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 't2d_register_runner',
    description:
      'Register a compute runner the user controls: any machine reachable over SSH (a cloud server, a GPU box, '
      + 'a cluster head). Runs are then dispatched to it. auth is "key" (agent/public-key, stores no secret, the '
      + 'normal path) or "sshpass" (password), and for sshpass you supply a pointer only — passwordEnv names an '
      + 'environment variable or passwordFile names a 0600 file; the secret is never stored or returned. Set '
      + 'defaultImage so later runs containerize for isolation.',
    parameters: {
      name: { ...STRING_PARAM, required: true, description: 'Stable handle for later calls, e.g. "gpu-box".' },
      host: { ...STRING_PARAM, required: true, description: 'SSH host or IP of the server.' },
      port: { type: 'integer', description: 'SSH port; default 22.' },
      user: { ...STRING_PARAM, description: 'SSH user; default root.' },
      auth: { type: 'string', enum: ['key', 'sshpass'], description: 'Authentication: "key" (default) or "sshpass".' },
      passwordEnv: { ...STRING_PARAM, description: 'sshpass only: name of an env var holding the password.' },
      passwordFile: { ...STRING_PARAM, description: 'sshpass only: path to a 0600 file holding the password.' },
      defaultImage: { ...STRING_PARAM, description: 'Container image used when a run asks for isolation.' },
      labels: { type: 'array', description: 'Free-form tags for grouping/selection.', items: { type: 'string' } },
    },
    output: { schema: { type: 'string' }, render: jsonRender },
    execute(args) {
      const input: RunnerInput = {
        name: args.name,
        host: args.host,
        port: args.port,
        user: args.user,
        auth: args.auth as RunnerInput['auth'],
        passwordEnv: args.passwordEnv,
        passwordFile: args.passwordFile,
        defaultImage: args.defaultImage,
        labels: args.labels,
      }
      return guarded(() => engine.registerRunner(input))
    },
    presentCall: args => ({ card: 'generic', title: `Register runner ${args.name}`, kind: 'execute', rawInput: { name: args.name, host: args.host, auth: args.auth ?? 'key' } }),
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 't2d_list_runners',
    description:
      'List every registered runner: name, host, port, user, auth kind, default image and labels. Shows credential '
      + 'pointers only (env var name / file path), never the secret itself. Read-only; run it first to see what exists.',
    parameters: {},
    output: { schema: { type: 'string' }, render: jsonRender },
    execute: () => guarded((): Runner[] => engine.listRunners()),
    presentCall: () => ({ card: 'generic', title: 'List registered runners', kind: 'fetch', rawInput: {} }),
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 't2d_remove_runner',
    description: 'Forget a registered runner by name. This does not touch anything already running on it.',
    parameters: {
      name: { ...STRING_PARAM, required: true, description: 'Runner handle to remove.' },
    },
    output: { schema: { type: 'string' }, render: jsonRender },
    execute: args => guarded(() => ({ removed: engine.removeRunner(args.name) })),
    presentCall: args => ({ card: 'generic', title: `Remove runner ${args.name}`, kind: 'execute', rawInput: { name: args.name } }),
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 't2d_run',
    description:
      'Dispatch one command to a registered runner and track it as a job. If an image is given (or the runner has a '
      + 'defaultImage and native is not set) it starts as a detached Docker container for isolation; otherwise it runs '
      + 'backgrounded directly on the host. Returns a job id for t2d_status / t2d_logs / t2d_stop. Restate what will run '
      + 'where before a heavy or destructive command.',
    parameters: {
      runner: { ...STRING_PARAM, required: true, description: 'Runner name from t2d_list_runners.' },
      command: { ...STRING_PARAM, required: true, description: 'Shell command to run on the runner.' },
      image: { ...STRING_PARAM, description: 'Container image for this run; overrides the runner default.' },
      native: { type: 'boolean', description: 'Force running on the host without a container.' },
      mounts: {
        type: 'array',
        description: 'Host paths to bind into the container (stage files first with t2d_copy_to, then mount them). Requires a container run.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            host: { type: 'string', required: true, description: 'Absolute path on the runner host.' },
            container: { type: 'string', required: true, description: 'Absolute mount point inside the container.' },
            readonly: { type: 'boolean', description: 'Mount read-only.' },
          },
        },
      },
    },
    output: { schema: { type: 'string' }, render: jsonRender },
    execute: args => guarded(() => engine.run({
      runner: args.runner,
      command: args.command,
      image: args.image,
      native: args.native,
      mounts: args.mounts as ContainerMount[] | undefined,
    })),
    presentCall: args => ({
      card: 'generic',
      title: `Run on ${args.runner}`,
      kind: 'execute',
      rawInput: { runner: args.runner, command: args.command, image: args.image ?? 'default', native: args.native ?? false, mounts: args.mounts?.length ?? 0 },
    }),
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 't2d_status',
    description: 'Query a job\'s live state (RUNNING / SUCCEEDED / FAILED / STOPPED / UNKNOWN) and exit code, and refresh the ledger.',
    parameters: {
      jobId: { ...STRING_PARAM, required: true, description: 'Job id from t2d_run.' },
    },
    output: { schema: { type: 'string' }, render: jsonRender },
    execute: args => guarded(() => engine.status(args.jobId)),
    presentCall: args => ({ card: 'generic', title: `Status of job ${args.jobId}`, kind: 'fetch', rawInput: { jobId: args.jobId } }),
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 't2d_logs',
    description: 'Read the last lines of a job\'s output (container logs or the native log file) to show or diagnose results.',
    parameters: {
      jobId: { ...STRING_PARAM, required: true, description: 'Job id from t2d_run.' },
      tail: { type: 'integer', description: 'Number of trailing lines to fetch; default 100.' },
      follow: { type: 'integer', description: 'Live-sample the log for this many seconds then stop; omit for a one-shot tail.' },
    },
    output: { schema: { type: 'string' }, render: jsonRender },
    execute: args => guarded(() => engine.logs(args.jobId, args.tail ?? 100, args.follow)),
    presentCall: args => ({ card: 'generic', title: `Logs of job ${args.jobId}`, kind: 'fetch', rawInput: { jobId: args.jobId, tail: args.tail ?? 100, follow: args.follow ?? 0 } }),
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 't2d_stop',
    description: 'Stop a running job (remove the container / kill the backgrounded process). Confirm before stopping work that may matter to the user.',
    parameters: {
      jobId: { ...STRING_PARAM, required: true, description: 'Job id to stop.' },
    },
    output: { schema: { type: 'string' }, render: jsonRender },
    execute: args => guarded(() => engine.stop(args.jobId)),
    presentCall: args => ({ card: 'generic', title: `Stop job ${args.jobId}`, kind: 'execute', rawInput: { jobId: args.jobId } }),
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 't2d_copy_to',
    description:
      'Push a local file or directory to a runner host over scp (recursive for directories). Use it to send local ' +
      'code, data or a skill to the machine before running it there — typically copy_to first, then t2d_run with ' +
      'mounts that bind the staged host path into the container.',
    parameters: {
      runner: { ...STRING_PARAM, required: true, description: 'Runner name from t2d_list_runners.' },
      local: { ...STRING_PARAM, required: true, description: 'Local file or directory path.' },
      remote: { ...STRING_PARAM, required: true, description: 'Destination path on the runner host.' },
      recursive: { type: 'boolean', description: 'Copy a directory tree.' },
    },
    output: { schema: { type: 'string' }, render: jsonRender },
    execute: args => guarded(() => engine.copyTo({ runner: args.runner, local: args.local, remote: args.remote, recursive: args.recursive })),
    presentCall: args => ({ card: 'generic', title: `Upload to ${args.runner}`, kind: 'execute', rawInput: { runner: args.runner, local: args.local, remote: args.remote, recursive: args.recursive ?? false } }),
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 't2d_copy_from',
    description:
      'Pull a file or directory from a runner host back to the local machine over scp (recursive for directories). ' +
      'Use it to fetch task artifacts — checkpoints, reports, outputs written under the container/host path.',
    parameters: {
      runner: { ...STRING_PARAM, required: true, description: 'Runner name from t2d_list_runners.' },
      remote: { ...STRING_PARAM, required: true, description: 'Source path on the runner host.' },
      local: { ...STRING_PARAM, required: true, description: 'Destination on the local machine.' },
      recursive: { type: 'boolean', description: 'Copy a directory tree.' },
    },
    output: { schema: { type: 'string' }, render: jsonRender },
    execute: args => guarded(() => engine.copyFrom({ runner: args.runner, remote: args.remote, local: args.local, recursive: args.recursive })),
    presentCall: args => ({ card: 'generic', title: `Download from ${args.runner}`, kind: 'execute', rawInput: { runner: args.runner, remote: args.remote, local: args.local, recursive: args.recursive ?? false } }),
  })))
}
