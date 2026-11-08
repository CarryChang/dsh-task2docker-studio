/**
 * Deterministic offline smoke for the vendor-neutral task-to-runner backend. No network, no ssh and no
 * credentials: a controllable fake SshClient answers each composed command, a temp directory backs the
 * Store, and a counter makes job ids stable — so registration, container vs native planning, status /
 * logs / stop parsing and secret-pointer resolution all run without touching a real machine.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  shQuote, composeContainerStart, composeContainerStatus, composeNativeStart,
  buildSshArgv, buildSshPassArgv,
} from '../src/backend/ssh.ts'
import { normalizeRunner, resolvePassword, Store } from '../src/backend/registry.ts'
import { Task2DockerEngine } from '../src/backend/engine.ts'
import { Task2DockerError, type ExecResult, type SshClient, type SshTarget } from '../src/backend/types.ts'
import { SKILL_BODY } from '../src/skill.ts'

// --- shell quoting + command composition ------------------------------------
assert.equal(shQuote("it's"), `'it'\\''s'`)
const cstart = composeContainerStart('t2d-abc', 'pytorch:2.4', 'python train.py')
assert.match(cstart, /^docker run -d --name 't2d-abc' 'pytorch:2\.4' bash -lc 'python train\.py'$/)
assert.match(composeContainerStatus('t2d-abc'), /docker inspect -f/)
assert.match(composeNativeStart('sleep 100', '/tmp/t2d-x.log'), /nohup bash -lc 'sleep 100' > '\/tmp\/t2d-x\.log' 2>&1 & echo \$!$/)

const target: SshTarget = { host: '203.0.113.10', port: 2200, user: 'root', auth: 'key' }
const keyArgv = buildSshArgv(target, 'ls')
assert.ok(keyArgv.includes('-p') && keyArgv.includes('2200'))
assert.ok(keyArgv.includes('root@203.0.113.10'))
assert.ok(keyArgv.includes('BatchMode=yes'))
assert.equal(keyArgv[keyArgv.length - 1], 'ls')
const pwArgv = buildSshPassArgv(target, 'ls', '/tmp/pw')
assert.deepEqual(pwArgv.slice(0, 3), ['-f', '/tmp/pw', 'ssh'])

// --- runner normalization + password pointer resolution ---------------------
const norm = normalizeRunner({ name: ' gpu1 ', host: ' 10.0.0.5 ' })
assert.equal(norm.name, 'gpu1')
assert.equal(norm.host, '10.0.0.5')
assert.equal(norm.port, 22)
assert.equal(norm.user, 'root')
assert.equal(norm.auth, 'key')
assert.throws(() => normalizeRunner({ name: '', host: 'x' }), /non-empty name/)
assert.throws(() => normalizeRunner({ name: 'a', host: 'x', auth: 'sshpass' }), /neither passwordEnv nor passwordFile/)

const pwRunner = normalizeRunner({ name: 'a', host: 'x', auth: 'sshpass', passwordEnv: 'MY_PW' })
assert.equal(resolvePassword(pwRunner, { MY_PW: 'hunter2' }), 'hunter2')
assert.throws(() => resolvePassword(pwRunner, {}), /empty right now/)
const pwFilePath = join(tmpdir(), 't2d-smoke-pw.txt')
writeFileSync(pwFilePath, 'secret\n', { mode: 0o600 })
const fileRunner = normalizeRunner({ name: 'b', host: 'x', auth: 'sshpass', passwordFile: pwFilePath })
assert.equal(resolvePassword(fileRunner), 'secret')
rmSync(pwFilePath, { force: true })

// --- fake SSH client driving the engine -------------------------------------
function makeFake() {
  const calls: Array<{ target: SshTarget; command: string }> = []
  let next: ExecResult = { ok: true, exitCode: 0, stdout: '', stderr: '' }
  const ssh: SshClient = {
    async run(t, c) { calls.push({ target: t, command: c }); return next },
  }
  return { ssh, calls, setNext: (r: Partial<ExecResult>) => { next = { ok: true, exitCode: 0, stdout: '', stderr: '', ...r } } }
}

const stateDir = mkdtempSync(join(tmpdir(), 't2d-smoke-'))
try {
  const fake = makeFake()
  let counter = 0
  const engine = new Task2DockerEngine(new Store(stateDir), fake.ssh, {
    idFactory: () => String(++counter).padStart(3, '0'),
    now: () => '2026-11-08T00:00:00.000Z',
  })

  engine.registerRunner({ name: 'gpu1', host: '10.0.0.5', defaultImage: 'pytorch:2.4' })
  engine.registerRunner({ name: 'plain', host: '10.0.0.6' })
  assert.deepEqual(engine.listRunners().map(r => r.name).sort(), ['gpu1', 'plain'])

  // container run: image present -> docker run, handle is the deterministic container name
  fake.setNext({ ok: true, exitCode: 0, stdout: 'containerid123\n', stderr: '' })
  const job = await engine.run({ runner: 'gpu1', command: 'python train.py' })
  assert.equal(job.mode, 'container')
  assert.equal(job.state, 'RUNNING')
  assert.ok(job.handle.kind === 'container' && job.handle.container === 't2d-001')
  assert.match(fake.calls.at(-1)!.command, /^docker run -d --name 't2d-001' 'pytorch:2\.4'/)

  // native run: no image -> nohup backgrounded, pid parsed from stdout
  fake.setNext({ ok: true, exitCode: 0, stdout: '  4242\n', stderr: '' })
  const native = await engine.run({ runner: 'plain', command: 'sleep 100' })
  assert.equal(native.mode, 'native')
  assert.ok(native.handle.kind === 'native' && native.handle.pid === '4242')

  // status parsing
  fake.setNext({ stdout: 'running|-1' })
  assert.equal((await engine.status('001')).state, 'RUNNING')
  fake.setNext({ stdout: 'exited|0' })
  assert.equal((await engine.status('001')).state, 'SUCCEEDED')
  assert.equal((await engine.status('001')).exitCode, 0)
  fake.setNext({ stdout: 'exited|1' })
  assert.equal((await engine.status('001')).state, 'FAILED')
  fake.setNext({ stdout: 'MISSING|-1' })
  assert.equal((await engine.status('001')).state, 'UNKNOWN')
  fake.setNext({ stdout: 'RUNNING|-1' })
  assert.equal((await engine.status('002')).state, 'RUNNING', 'native running')
  fake.setNext({ stdout: 'DONE' })
  assert.equal((await engine.status('002')).state, 'SUCCEEDED', 'native done')

  // logs + stop
  fake.setNext({ stdout: 'epoch 3 loss 0.1\n' })
  assert.equal((await engine.logs('001', 50)).output, 'epoch 3 loss 0.1\n')
  assert.match(fake.calls.at(-1)!.command, /docker logs --tail 50 't2d-001'/)
  fake.setNext({ stdout: 'STOPPED\n' })
  assert.equal((await engine.stop('001')).state, 'STOPPED')

  // ledger persists across a fresh Store on the same directory
  const reopened = new Task2DockerEngine(new Store(stateDir), fake.ssh, { idFactory: () => 'zzz', now: () => 'x' })
  assert.equal(reopened.listRunners().map(r => r.name).sort().join(','), 'gpu1,plain')
  assert.ok(reopened.listRunners().find(r => r.name === 'gpu1')?.defaultImage)

  // failures surface as actionable errors, not crashes
  await assert.rejects(() => engine.run({ runner: 'missing', command: 'x' }), /No runner named "missing"/)
  await assert.rejects(() => engine.run({ runner: 'gpu1', command: '   ' }), /non-empty command/)

  // a failing start does not create a job
  fake.setNext({ ok: false, exitCode: 125, stderr: 'docker: command not found\n' })
  await assert.rejects(() => engine.run({ runner: 'gpu1', command: 'echo hi' }), /command not found/)

  // password pointer is resolved into the target at call time, never stored
  const secretRunner = normalizeRunner({ name: 'sec', host: '10.0.0.9', auth: 'sshpass', passwordEnv: 'SEC_PW' })
  new Store(stateDir).putRunner(secretRunner)
  const withSecret = new Task2DockerEngine(new Store(stateDir), fake.ssh, { idFactory: () => 's1', now: () => 'x' })
  process.env['SEC_PW'] = 'topsecret'
  fake.setNext({ ok: true, stdout: '999', stderr: '' })
  await withSecret.run({ runner: 'sec', command: 'whoami', native: true })
  assert.equal(fake.calls.at(-1)!.target.password, 'topsecret')
  assert.equal(fake.calls.at(-1)!.target.auth, 'sshpass')
  delete process.env['SEC_PW']
  await assert.rejects(() => withSecret.run({ runner: 'sec', command: 'whoami', native: true }), /SEC_PW, which is empty/)

  // --- skill boot safety -----------------------------------------------------
  assert.ok(!SKILL_BODY.includes('`'), 'SKILL_BODY must not contain raw backticks')
  for (const tool of ['t2d_register_runner', 't2d_list_runners', 't2d_run', 't2d_status', 't2d_logs', 't2d_stop', 't2d_remove_runner']) {
    assert.ok(SKILL_BODY.includes(tool), `skill body walks through ${tool}`)
  }
  assert.ok(SKILL_BODY.includes('native') && SKILL_BODY.includes('container'), 'skill covers container vs native')
  assert.ok(!SKILL_BODY.includes('OpenBayes') && !SKILL_BODY.includes('HyperAI'), 'skill is vendor-neutral')
} finally {
  rmSync(stateDir, { recursive: true, force: true })
}

assert.ok(new Task2DockerError('x').actionable)
console.log('smoke: all task2docker (generic runner) assertions passed')
