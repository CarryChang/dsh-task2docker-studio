/**
 * Production remote executor: runs one shell command inside a container over SSH with non-interactive
 * password auth via `sshpass`, writing the secret to a 0600 temp file that is removed however the run
 * ends. The password is never placed on the command line and never returned. Requires `sshpass` and
 * `ssh` on the host; when `sshpass` is missing the caller should fall back to a key or the sandbox path.
 * @module dsh-task2docker-studio/backend/executor
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSshPassArgv, parseSshLink, type SpawnResult } from './ssh.ts'
import { Task2DockerError, type JobLink } from './types.ts'
import type { RemoteExecutor } from './runner.ts'

/** Spawn a binary with argv and capture stdout/stderr under a timeout. */
function spawnCapture(bin: string, argv: string[], timeoutMs: number): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Task2DockerError(`${bin} timed out after ${timeoutMs}ms and was killed.`))
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', error => { clearTimeout(timer); reject(new Task2DockerError(`Could not run ${bin}: ${error.message}`)) })
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }) })
  })
}

/**
 * Build the ssh command that writes the password to a private temp file and runs the remote command.
 * @param links - job links carrying `ssh`.
 * @param password - ssh/Jupyter shared secret from the job context.
 * @param command - remote shell command.
 * @param timeoutMs - overall command timeout.
 * @returns the resolved remote result.
 */
export function createSshExecutor(timeoutMs: number): RemoteExecutor {
  return async ({ host, port, user, password, command }) => {
    const dir = mkdtempSync(join(tmpdir(), 't2d-'))
    const pwFile = join(dir, 'pw')
    let result: SpawnResult
    try {
      writeFileSync(pwFile, password, { mode: 0o600 })
      chmodSync(pwFile, 0o600)
      const argv = buildSshPassArgv({ host, port, user }, command, pwFile, { strictHostKey: 'accept-new' })
      result = await spawnCapture('sshpass', argv, timeoutMs)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    return { ok: result.code === 0, exitCode: result.code, stdout: result.stdout, stderr: result.stderr }
  }
}

/**
 * Report whether the host can ssh at all, so the entry can disable `exec` early with a clear reason.
 * @param links - job links; only presence of an `ssh` entry is checked here.
 * @returns true when an ssh link exists.
 */
export function hasSshLink(links: JobLink[]): boolean {
  return links.some(l => l.name === 'ssh')
}

export { parseSshLink }
