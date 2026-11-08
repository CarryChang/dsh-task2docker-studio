/**
 * The task-to-docker engine: register any SSH-reachable runner and dispatch commands to it — in a
 * Docker container when an image is available, or backgrounded on the host otherwise. It composes the
 * pure command builders from `ssh.ts` and the `Store` ledger, and is fully unit-testable offline
 * through an injected `SshClient`.
 * @module dsh-task2docker-studio/backend/engine
 */

import { randomBytes } from 'node:crypto'
import {
  composeContainerLogs, composeContainerStart, composeContainerStatus, composeContainerStop,
  composeNativeLogs, composeNativeStart, composeNativeStatus, composeNativeStop,
} from './ssh.ts'
import { normalizeRunner, resolvePassword, Store, type RunnerInput } from './registry.ts'
import { Task2DockerError, type JobRecord, type JobState, type RunMode, type Runner, type SshClient, type SshTarget } from './types.ts'

/** Deterministic-id and clock seams so tests run without randomness. */
export interface EngineOptions {
  /** Generates a fresh short job id. Defaults to an 8-char random token. */
  idFactory?: () => string
  /** ISO timestamp source. Defaults to the wall clock. */
  now?: () => string
}

/** One remote command plus a short label for the ledger. */
interface Planned {
  command: string
  request: string
  mode: RunMode
  /** Interprets the start command's stdout into a job handle. */
  handle: (stdout: string) => JobRecord['handle']
}

/**
 * Runs jobs on registered runners and keeps a local ledger so later calls can find them by id.
 */
export class Task2DockerEngine {
  private readonly newId: () => string
  private readonly now: () => string

  /**
   * @param store - runner + job persistence.
   * @param ssh - remote command executor (production ssh client or a fake in tests).
   * @param options - id/clock seams.
   */
  constructor(private readonly store: Store, private readonly ssh: SshClient, options: EngineOptions = {}) {
    this.newId = options.idFactory ?? (() => randomBytes(4).toString('hex'))
    this.now = options.now ?? (() => new Date().toISOString())
  }

  /** Register (or replace) a runner from user-supplied fields; returns the stored definition. */
  registerRunner(input: RunnerInput): Runner {
    const runner = normalizeRunner(input)
    this.store.putRunner(runner)
    return runner
  }

  /**
   * List every registered runner. A stored runner carries only credential *pointers* (passwordEnv /
   * passwordFile), never the secret itself, so the list is safe to show.
   */
  listRunners(): Runner[] {
    return Object.values(this.store.runners())
  }

  /** Remove a runner by name; false when it was not present. */
  removeRunner(name: string): boolean {
    return this.store.deleteRunner(name)
  }

  /**
   * Dispatch one command to a runner and track it as a job.
   * @param args - runner name, command, optional image, and whether to force native (no container).
   * @returns the created job record.
   */
  async run(args: { runner: string; command: string; image?: string | undefined; native?: boolean | undefined }): Promise<JobRecord> {
    const runner = this.store.getRunner(args.runner)
    if (!args.command.trim()) throw new Task2DockerError('A run needs a non-empty command.')
    const id = this.newId()
    const useImage = args.native ? undefined : (args.image ?? runner.defaultImage)
    const plan: Planned = useImage
      ? planContainer(id, useImage, args.command)
      : planNative(id, args.command)
    const result = await this.ssh.run(this.target(runner), plan.command)
    if (!result.ok) {
      throw new Task2DockerError(`Failed to start the job on "${runner.name}": ${firstLine(result.stderr || result.stdout) || `exit ${result.exitCode}`}`)
    }
    const record: JobRecord = {
      id,
      runner: runner.name,
      mode: plan.mode,
      request: plan.request,
      state: 'RUNNING',
      exitCode: null,
      createdAt: this.now(),
      startedAt: this.now(),
      finishedAt: null,
      handle: plan.handle(result.stdout),
    }
    return this.store.putJob(record)
  }

  /** Re-query a job's live state, update the ledger, and return it. */
  async status(jobId: string): Promise<JobRecord> {
    const job = this.store.getJob(jobId)
    const runner = this.store.getRunner(job.runner)
    const probe = job.handle.kind === 'container'
      ? composeContainerStatus(job.handle.container)
      : composeNativeStatus(job.handle.pid, job.handle.log)
    const result = await this.ssh.run(this.target(runner), probe)
    const { state, exitCode } = job.handle.kind === 'container' ? parseContainerStatus(result.stdout) : parseNativeStatus(result.stdout)
    const next: JobRecord = {
      ...job,
      state,
      exitCode,
      finishedAt: state === 'RUNNING' ? null : this.now(),
    }
    return this.store.putJob(next)
  }

  /** Read the last `tail` lines of a job's output. */
  async logs(jobId: string, tail: number): Promise<{ output: string }> {
    const job = this.store.getJob(jobId)
    const runner = this.store.getRunner(job.runner)
    const probe = job.handle.kind === 'container'
      ? composeContainerLogs(job.handle.container, tail)
      : composeNativeLogs(job.handle.log, tail)
    const result = await this.ssh.run(this.target(runner), probe)
    return { output: result.stdout }
  }

  /** Stop a job (container rm / kill pid) and mark it stopped. */
  async stop(jobId: string): Promise<JobRecord> {
    const job = this.store.getJob(jobId)
    const runner = this.store.getRunner(job.runner)
    const probe = job.handle.kind === 'container'
      ? composeContainerStop(job.handle.container)
      : composeNativeStop(job.handle.pid)
    await this.ssh.run(this.target(runner), probe)
    const next: JobRecord = { ...job, state: 'STOPPED', exitCode: null, finishedAt: this.now() }
    return this.store.putJob(next)
  }

  /** Resolve an ephemeral SSH target (including the password at call time) for a runner. */
  private target(runner: Runner): SshTarget {
    return {
      host: runner.host,
      port: runner.port,
      user: runner.user,
      auth: runner.auth,
      password: resolvePassword(runner),
    }
  }
}

function planContainer(id: string, image: string, command: string): Planned {
  const container = `t2d-${id}`
  return {
    mode: 'container',
    command: composeContainerStart(container, image, command),
    request: `docker run ${image}: ${command}`,
    handle: () => ({ kind: 'container', container }),
  }
}

function planNative(id: string, command: string): Planned {
  const log = `/tmp/t2d-${id}.log`
  return {
    mode: 'native',
    command: composeNativeStart(command, log),
    request: `nohup ${command}`,
    handle: stdout => ({ kind: 'native', pid: stdout.trim().split(/\s+/).pop() ?? '', log }),
  }
}

function parseContainerStatus(stdout: string): { state: JobState; exitCode: number | null } {
  const [status, code] = stdout.trim().split('|')
  if (status === 'running') return { state: 'RUNNING', exitCode: null }
  if (status === 'MISSING') return { state: 'UNKNOWN', exitCode: null }
  const exit = Number.parseInt(code ?? '-1', 10)
  return { state: Number.isNaN(exit) ? 'UNKNOWN' : exit === 0 ? 'SUCCEEDED' : 'FAILED', exitCode: Number.isNaN(exit) ? null : exit }
}

function parseNativeStatus(stdout: string): { state: JobState; exitCode: number | null } {
  const trimmed = stdout.trim()
  if (trimmed.startsWith('RUNNING')) return { state: 'RUNNING', exitCode: null }
  if (trimmed.startsWith('DONE')) return { state: 'SUCCEEDED', exitCode: null }
  return { state: 'UNKNOWN', exitCode: null }
}

/** First non-empty line, for a compact failure reason. */
function firstLine(text: string): string {
  return text.split(/\r?\n/)[0]?.trim() ?? ''
}
