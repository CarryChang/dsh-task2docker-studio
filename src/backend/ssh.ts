/**
 * SSH data-plane for reaching a running container. This is the host-side controller path the
 * openbayes-user skill documents: parse `links.ssh`, build a non-interactive command, and hand the
 * argv to an injected process spawner so the plugin itself owns no child-process lifetime and the
 * parsing stays unit-testable without an ssh client.
 * @module dsh-task2docker-studio/backend/ssh
 */

import { Task2DockerError, type JobLink, type SshTarget } from './types.ts'

/**
 * Parse `ssh root@<host> -p<port>` into a target. Internal 10.x / 172.16-31.x / 192.168.x hosts are
 * container-to-container only and rejected here; from the host the external `links.ssh` host is required.
 * @param links - the `links` array from a job context.
 * @returns the parsed SSH target.
 */
export function parseSshLink(links: JobLink[]): SshTarget {
  const ssh = links.find(l => l.name === 'ssh')
  if (!ssh) {
    throw new Task2DockerError('This job exposes no ssh link yet. Links appear only when the container is RUNNING and provisioning finished; poll t2d_status first.')
  }
  const match = /ssh\s+(\S+)@(\S+)\s+-p\s*(\d+)/.exec(ssh.value)
  if (!match) {
    throw new Task2DockerError(`Could not parse the ssh link "${ssh.value}". Expected "ssh root@<host> -p<port>".`)
  }
  const user = match[1] ?? 'root'
  const host = match[2] ?? ''
  const port = Number.parseInt(match[3] ?? '0', 10)
  if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(host)) {
    throw new Task2DockerError(`Refusing to ssh to internal address ${host}; that is valid container-to-container only, not from the host.`)
  }
  if (!port) {
    throw new Task2DockerError('Parsed ssh link has no port.')
  }
  return { host, port, user }
}

/**
 * Build the argv for a non-interactive remote command using password auth. Prefers `sshpass -f <file>`;
 * when sshpass is unavailable the caller must fall back to a key or the sandbox path, so this returns
 * the password-file form and the spawner decides availability.
 * @param target - parsed ssh endpoint.
 * @param remoteCommand - single shell command string to run remotely.
 * @param passwordFile - path to a 0600 file holding the password; never the password inline.
 * @param opts - host-key and keepalive policy.
 * @returns argv for `sshpass`.
 */
export function buildSshPassArgv(
  target: SshTarget,
  remoteCommand: string,
  passwordFile: string,
  opts: { strictHostKey: 'accept-new' | 'no' },
): string[] {
  return [
    '-f', passwordFile,
    'ssh',
    '-o', `StrictHostKeyChecking=${opts.strictHostKey}`,
    '-o', 'BatchMode=yes',
    '-o', 'ServerAliveInterval=30',
    '-p', String(target.port),
    `${target.user}@${target.host}`,
    remoteCommand,
  ]
}

/**
 * Build the argv for a public-key ssh command (no sshpass, no password file).
 * @param target - parsed ssh endpoint.
 * @param remoteCommand - single shell command string to run remotely.
 * @returns argv for `ssh`.
 */
export function buildSshArgv(target: SshTarget, remoteCommand: string): string[] {
  return [
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'BatchMode=yes',
    '-o', 'ServerAliveInterval=30',
    '-p', String(target.port),
    `${target.user}@${target.host}`,
    remoteCommand,
  ]
}

/** Result of a spawned process, normalized from node:child_process. */
export interface SpawnResult {
  code: number
  stdout: string
  stderr: string
}

/** A process spawner seam: `run(bin, argv, timeoutMs)` resolves with captured output. */
export type SpawnFn = (bin: string, argv: string[], timeoutMs: number) => Promise<SpawnResult>
