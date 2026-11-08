/**
 * SSH data-plane: pure shell-quoting, remote-command composition and argv builders, plus a default
 * client that shells out to `ssh` / `sshpass`. The pure functions are unit-testable without spawning
 * anything; the client seam keeps the engine independent of a specific process spawner.
 * @module dsh-task2docker-studio/backend/ssh
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Task2DockerError, type ExecResult, type SshClient, type SshTarget } from './types.ts'

/** Wrap a value as a POSIX single-quoted string so it survives one shell layer verbatim. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Build a container start command that runs `cmd` detached and prints the container id.
 * @param container - deterministic name to launch the container under.
 * @param image - container image.
 * @param cmd - the task command to run inside the container.
 * @returns a single remote shell command string.
 */
export function composeContainerStart(container: string, image: string, cmd: string): string {
  return `docker run -d --name ${shQuote(container)} ${shQuote(image)} bash -lc ${shQuote(cmd)}`
}

/** Build a `docker inspect` that reports state and exit code as `status|exitCode`. */
export function composeContainerStatus(container: string): string {
  return `docker inspect -f '{{.State.Status}}|{{.State.ExitCode}}' ${shQuote(container)} 2>/dev/null || echo MISSING|-1`
}

/** Build a bounded `docker logs` read. */
export function composeContainerLogs(container: string, tail: number): string {
  return `docker logs --tail ${Math.max(1, Math.trunc(tail))} ${shQuote(container)} 2>&1`
}

/** Build a container remove (force, so RUNNING containers stop too). */
export function composeContainerStop(container: string): string {
  return `docker rm -f ${shQuote(container)} >/dev/null 2>&1 && echo STOPPED || echo GONE`
}

/**
 * Build a native backgrounded run: create a log dir, nohup the command, and print the PID on stdout.
 * @param cmd - the task command.
 * @param log - absolute path (on the host) to write combined output to.
 * @returns a single remote shell command string.
 */
export function composeNativeStart(cmd: string, log: string): string {
  return `mkdir -p $(dirname ${shQuote(log)}); nohup bash -lc ${shQuote(cmd)} > ${shQuote(log)} 2>&1 & echo $!`
}

/** Build a native status probe from a recorded PID and log path. */
export function composeNativeStatus(pid: string, log: string): string {
  return `if kill -0 ${shQuote(pid)} 2>/dev/null; then echo RUNNING|-1; else echo DONE|$(tail -n 1 ${shQuote(log)} 2>/dev/null | tr -d '\\r'); fi`
}

/** Build a bounded tail of a native run's log. */
export function composeNativeLogs(log: string, tail: number): string {
  return `tail -n ${Math.max(1, Math.trunc(tail))} ${shQuote(log)} 2>&1`
}

/** Build a native stop (best-effort kill) from a recorded PID. */
export function composeNativeStop(pid: string): string {
  return `kill ${shQuote(pid)} 2>/dev/null && echo STOPPED || echo GONE`
}

/**
 * Build the `ssh` argv for public-key / agent auth (no password).
 * @param target - resolved endpoint.
 * @param remoteCommand - command to run remotely.
 * @returns argv passed to the `ssh` binary.
 */
export function buildSshArgv(target: SshTarget, remoteCommand: string): string[] {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=30',
    '-p', String(target.port),
    `${target.user}@${target.host}`,
    remoteCommand,
  ]
}

/**
 * Build the `sshpass` argv for password auth, reading the secret from a file, never the command line.
 * @param target - resolved endpoint.
 * @param remoteCommand - command to run remotely.
 * @param passwordFile - path to a 0600 file holding the password.
 * @returns argv passed to the `sshpass` binary (which then invokes `ssh`).
 */
export function buildSshPassArgv(target: SshTarget, remoteCommand: string, passwordFile: string): string[] {
  return [
    '-f', passwordFile,
    'ssh', ...buildSshArgv(target, remoteCommand),
  ]
}

/** Raw process spawn seam; injected in tests to avoid launching real binaries. */
export type SpawnFn = (bin: string, argv: string[], timeoutMs: number) => Promise<ExecResult>

/** Default spawner: run a binary to completion, capture output, hard-kill after the per-call timeout. */
export function defaultSpawn(): SpawnFn {
  return (bin, argv, timeout) => new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(bin, argv, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Task2DockerError(`${bin} timed out after ${timeout}ms and was killed.`))
    }, timeout)
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', error => { clearTimeout(timer); reject(new Task2DockerError(`Could not run ${bin}: ${error.message}`)) })
    child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, exitCode: code ?? -1, stdout, stderr }) })
  })
}

/**
 * Create the production SSH client. Password auth requires `sshpass` on the host; the secret is
 * written to a 0600 temp file and removed however the run ends, and is never returned.
 * @param timeoutMs - per-command timeout.
 * @param spawnFn - process spawner (default `defaultSpawn()`).
 * @returns an SSH client.
 */
export function createSshClient(timeoutMs: number, spawnFn: SpawnFn = defaultSpawn()): SshClient {
  return {
    async run(target, remoteCommand) {
      if (target.auth === 'key') {
        return spawnFn('ssh', buildSshArgv(target, remoteCommand), timeoutMs)
      }
      if (!target.password) {
        throw new Task2DockerError(`Runner ssh target for ${target.host} uses sshpass but no password was resolved. Set the runner's passwordEnv or passwordFile.`)
      }
      const dir = mkdtempSync(join(tmpdir(), 't2d-'))
      const pwFile = join(dir, 'pw')
      try {
        writeFileSync(pwFile, target.password, { mode: 0o600 })
        chmodSync(pwFile, 0o600)
        return await spawnFn('sshpass', buildSshPassArgv(target, remoteCommand, pwFile), timeoutMs)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  }
}
