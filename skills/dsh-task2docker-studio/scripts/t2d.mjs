#!/usr/bin/env node
/**
 * Standalone CLI for the dsh-task2docker-studio Agent Skill. Runs the same dispatch logic as the DeepSeek
 * Harness t2d_* tools with plain Node and no harness, so Claude Code / Cursor / Copilot can call it through
 * their shell tool. It talks to runners over `ssh` / `sshpass` and Docker, exactly like the plugin.
 *
 * Usage:
 *   node t2d.mjs register --name <n> --host <h> [--port 22] [--user root] [--auth key|sshpass]
 *                         [--password-env <VAR>] [--password-file <path>] [--image <img>] [--labels a,b]
 *   node t2d.mjs list
 *   node t2d.mjs remove --name <n>
 *   node t2d.mjs run    --runner <n> --command "<cmd>" [--image <img>] [--native]   (or pipe command on stdin)
 *   node t2d.mjs status --job <id>
 *   node t2d.mjs logs   --job <id> [--tail 100]
 *   node t2d.mjs stop   --job <id>
 *
 * State (runners + jobs) lives in $T2D_STATE_DIR or ~/.dsh-task2docker. Passwords are read at call time
 * from $T2D_* env names or a 0600 file given at register; nothing secret is stored or printed.
 * Prints one JSON object to stdout: { ok: true, result } or { ok: false, error }. Non-zero exit on error.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createSshClient } from './lib/backend/ssh.js'
import { Store } from './lib/backend/registry.js'
import { Task2DockerEngine } from './lib/backend/engine.js'

/** Parse `--flag value`, valueless `--flag` (boolean), and a trailing positional into a map. */
function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else {
      positional.push(a)
    }
  }
  return { flags, positional }
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

const [, , command, ...rest] = process.argv
const { flags } = parseArgs(rest)

const stateDir = typeof process.env['T2D_STATE_DIR'] === 'string' && process.env['T2D_STATE_DIR']
  ? process.env['T2D_STATE_DIR']
  : join(homedir(), '.dsh-task2docker')
const timeoutSec = Number(process.env['T2D_SSH_TIMEOUT_SEC'] ?? 60)
const engine = new Task2DockerEngine(new Store(stateDir), createSshClient(Math.max(1, timeoutSec) * 1000))

function requireFlag(name) {
  const value = flags[name]
  if (typeof value !== 'string' || !value) {
    throw new Error(`missing --${name}`)
  }
  return value
}

/** Dispatch the requested subcommand against the engine. */
async function main() {
  switch (command) {
    case 'register':
      return engine.registerRunner({
        name: requireFlag('name'),
        host: requireFlag('host'),
        port: flags.port ? Number(flags.port) : undefined,
        user: typeof flags.user === 'string' ? flags.user : undefined,
        auth: flags.auth === 'sshpass' ? 'sshpass' : flags.auth === 'key' ? 'key' : undefined,
        passwordEnv: typeof flags['password-env'] === 'string' ? flags['password-env'] : undefined,
        passwordFile: typeof flags['password-file'] === 'string' ? flags['password-file'] : undefined,
        defaultImage: typeof flags.image === 'string' ? flags.image : undefined,
        labels: typeof flags.labels === 'string' ? String(flags.labels).split(',').map(s => s.trim()).filter(Boolean) : undefined,
      })
    case 'list':
      return engine.listRunners()
    case 'remove':
      return { removed: engine.removeRunner(requireFlag('name')) }
    case 'run': {
      const runner = requireFlag('runner')
      let cmd = typeof flags.command === 'string' ? flags.command : undefined
      if (!cmd && !process.stdin.isTTY) cmd = (await readStdin()).trim()
      if (!cmd) throw new Error('missing --command (or pipe the command on stdin)')
      return await engine.run({
        runner,
        command: cmd,
        image: typeof flags.image === 'string' ? flags.image : undefined,
        native: flags.native === true,
      })
    }
    case 'status':
      return await engine.status(requireFlag('job'))
    case 'logs':
      return await engine.logs(requireFlag('job'), flags.tail ? Number(flags.tail) : 100)
    case 'stop':
      return await engine.stop(requireFlag('job'))
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return { usage: readFileSync(process.argv[1], 'utf8').split('\n').slice(2, 20).join('\n') }
    default:
      throw new Error(`unknown command "${command}"; try: register | list | remove | run | status | logs | stop`)
  }
}

try {
  console.log(JSON.stringify({ ok: true, result: await main() }, null, 2))
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2))
  process.exitCode = 1
}
