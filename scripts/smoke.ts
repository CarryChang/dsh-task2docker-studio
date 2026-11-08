/**
 * Deterministic offline smoke for the task-to-docker backend. No network, no credentials: a fake
 * GraphQL transport answers each operation with a recorded payload and a fake remote executor stands
 * in for sshpass, so the whole dispatch flow — payload assembly, mode gating, catalog mapping, ssh
 * link parsing, status polling and exec — runs without a live platform.
 */
import assert from 'node:assert/strict'
import { normalizeToken, requireField } from '../src/backend/transport.ts'
import { buildCreateJobVariables, runtimeId } from '../src/backend/operations.ts'
import { parseSshLink, buildSshPassArgv, buildSshArgv } from '../src/backend/ssh.ts'
import { Task2DockerRunner } from '../src/backend/runner.ts'
import { Task2DockerError, type GraphQLTransport } from '../src/backend/types.ts'
import { SKILL_BODY } from '../src/skill.ts'

// --- token + field guards ---------------------------------------------------
assert.equal(normalizeToken('abc'), 'Bearer abc')
assert.equal(normalizeToken('Bearer abc'), 'Bearer abc')
assert.throws(() => requireField({ createJob: null }, 'createJob'), /did not take effect/)
assert.equal(requireField({ me: { x: 1 } }, 'me').x, 1)

// --- runtime id -------------------------------------------------------------
assert.equal(runtimeId('pytorch', '2.11-py312-cu124'), 'pytorch-2.11-py312-cu124')

// --- create payload assembly ------------------------------------------------
const task = buildCreateJobVariables('alice', { runtime: 'pytorch-2.11-py312-cu124', resource: 'a100-1', command: 'python train.py' }, { runtime: '', resource: '' })
assert.equal(task.userId, 'alice')
assert.equal(task.input.mode, 'TASK')
assert.deepEqual(task.input.newTask, { command: 'python train.py' })
assert.equal(task.input.runtime, 'pytorch-2.11-py312-cu124')
assert.equal(task.input.resource, 'a100-1')
assert.equal('newWorkspace' in task.input, false)

const bareTask = buildCreateJobVariables('alice', { runtime: 'r', resource: 'c' }, { runtime: '', resource: '' })
assert.deepEqual(bareTask.input.newTask, {}, 'TASK with no command sends an empty newTask')

const ws = buildCreateJobVariables('alice', { runtime: 'r', resource: 'c', mode: 'WORKSPACE' }, { runtime: '', resource: '' })
assert.equal(ws.input.mode, 'WORKSPACE')
assert.deepEqual(ws.input.newWorkspace, {})

// defaults fill omitted runtime/resource
const defaulted = buildCreateJobVariables('alice', { runtime: '', resource: '' }, { runtime: 'pytorch-2-x', resource: 'rtx-4090-1' })
assert.equal(defaulted.input.runtime, 'pytorch-2-x')
assert.equal(defaulted.input.resource, 'rtx-4090-1')

// mode gating: unsupported modes rejected
assert.throws(() => buildCreateJobVariables('a', { runtime: 'r', resource: 'c', mode: 'VIRTUAL_MACHINE' as never }, { runtime: '', resource: '' }), /Only TASK and WORKSPACE/)
assert.throws(() => buildCreateJobVariables('a', { runtime: '', resource: 'c' }, { runtime: '', resource: '' }), /No runtime selected/)

// reserved parameter prefix + secret flag + binding path validation
const withParams = buildCreateJobVariables('a', {
  runtime: 'r', resource: 'c',
  parameters: [{ name: 'LR', value: 0.001 }, { name: 'HF_TOKEN', value: 'secret', isSecret: true }],
  dataBindings: [{ name: 'a/ds/v1', path: '/input0' }],
}, { runtime: '', resource: '' })
const params = withParams.input.parameters as Array<Record<string, unknown>>
assert.equal(params[0]?.value, 0.001)
assert.equal(params[1]?.isSecret, true, 'secret flagged')
const bindings = withParams.input.dataBindings as Array<Record<string, unknown>>
assert.equal(bindings[0]?.bindingType, 'DATASET')
assert.equal(bindings[0]?.bindingAuth, 'READ_ONLY')
assert.throws(() => buildCreateJobVariables('a', { runtime: 'r', resource: 'c', parameters: [{ name: 'OPENBAYES_X', value: 1 }] }, { runtime: '', resource: '' }), /reserved OPENBAYES_/)
assert.throws(() => buildCreateJobVariables('a', { runtime: 'r', resource: 'c', dataBindings: [{ name: 'a/d/v', path: '/output' }] }, { runtime: '', resource: '' }), /never mount at \/output/)
assert.throws(() => buildCreateJobVariables('a', { runtime: 'r', resource: 'c', dataBindings: [{ name: 'a/d/v', path: '/data' }] }, { runtime: '', resource: '' }), /canonical/)

// --- ssh link parsing -------------------------------------------------------
const sshLinks = [{ name: 'ssh', value: 'ssh root@ssh.openbayes.com -p22001' }, { name: 'auxiliary', value: 'https://x' }]
const target = parseSshLink(sshLinks)
assert.deepEqual(target, { host: 'ssh.openbayes.com', port: 22001, user: 'root' })
assert.throws(() => parseSshLink([{ name: 'workspace', value: 'https://x' }]), /no ssh link/)
assert.throws(() => parseSshLink([{ name: 'ssh', value: 'ssh root@10.1.2.3 -p22' }]), /internal address/)
assert.throws(() => parseSshLink([{ name: 'ssh', value: 'garbage' }]), /Could not parse/)
const passArgv = buildSshPassArgv(target, 'nvidia-smi', '/tmp/pw', { strictHostKey: 'accept-new' })
assert.deepEqual(passArgv.slice(0, 2), ['-f', '/tmp/pw'])
assert.ok(passArgv.includes('BatchMode=yes'))
assert.ok(passArgv.includes('root@ssh.openbayes.com'))
assert.equal(passArgv[passArgv.length - 1], 'nvidia-smi')
assert.ok(!buildSshArgv(target, 'ls').includes('sshpass'), 'key argv has no sshpass')

// --- fake transport driving the full runner flow ----------------------------
const whoamiData = { me: { username: 'alice', displayName: 'Alice', roles: ['USER'], locked: false, account: { balance: { amount: '100.00', currency: 'CNY' }, debtMoney: { amount: '0', currency: 'CNY' } }, quota: { storageQuota: { remainMegaBytes: 4096 }, computationQuota: [{ key: 'gpu', value: { availableMinutes: 120 } }] }, jobs: { pageInfo: { total: 2 } } } }
const runtimesData = { normalClusterRuntimes: [
  { framework: 'pytorch', version: '2.11-py312-cu124', device: 'GPU', deprecated: false, labels: ['MACHINE_LEARNING'] },
  { framework: 'ubuntu', version: '24.04-py312', device: 'CPU', deprecated: false, labels: [] },
] }
const resourcesData = { normalClusterResources: [
  { name: 'a100-1', verboseName: 'A100 x1', gpuResource: 'a100', affordable: true, isFullLoad: false, gpu: [{ name: 'a100', count: 1 }] },
  { name: 'h800-8', verboseName: 'H800 x8', gpuResource: 'h800', affordable: false, isFullLoad: true, gpu: [{ name: 'h800', count: 8 }] },
] }
const createdJob = { id: 'job123', name: 'p1', mode: 'TASK', status: 'CREATED', resource: { name: 'a100-1' }, runtime: { framework: 'pytorch', version: '2.11-py312-cu124' }, links: [] }
const runningJob = { id: 'job123', name: 'p1', mode: 'WORKSPACE', status: 'RUNNING', subStatus: null, startedAt: '2026-11-08T00:00:00Z', endAt: null, canStop: true, resource: { name: 'a100-1' }, runtime: { framework: 'pytorch', version: '2.11' }, links: sshLinks, password: 'supersecret' }
const jobList = { party: { jobs: { data: [ { id: 'job1', name: 'a', mode: 'TASK', status: 'RUNNING', resource: { name: 'a100-1' }, runtime: { framework: 'pytorch', version: '2.11' }, links: [] } ], pageInfo: { total: 1 } } } }

let lastCreateVariables: Record<string, unknown> | undefined
const transport: GraphQLTransport = {
  async execute<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    if (query.includes('query Whoami')) return whoamiData as T
    if (query.includes('normalClusterRuntimes')) return runtimesData as T
    if (query.includes('normalClusterResources')) return resourcesData as T
    if (query.includes('mutation CreateJob')) { lastCreateVariables = variables; return { createJob: createdJob } as T }
    if (query.includes('query LoadJobContext')) return { job: runningJob } as T
    if (query.includes('query LoadMyJobs')) return jobList as T
    if (query.includes('mutation StopJob')) return { stopJob: { id: 'job123', status: 'CANCELLING' } } as T
    throw new Error(`unexpected query: ${query.slice(0, 40)}`)
  },
}

let execCapture: { command: string; password: string; host: string; port: number } | undefined
const runner = new Task2DockerRunner(transport, {
  defaultResource: 'a100-1',
  defaultRuntime: 'pytorch-2.11-py312-cu124',
  remote: async a => { execCapture = { command: a.command, password: a.password, host: a.host, port: a.port }; return { ok: true, exitCode: 0, stdout: 'gpu ok\n', stderr: '' } },
})

const who = await runner.whoami()
assert.equal(who.username, 'alice')
assert.equal(who.activeJobs, 2)
assert.equal(who.availableMinutes, 120)
assert.equal(who.balance, '100.00 CNY')

const cat = await runner.catalog()
assert.equal(cat.runtimes[0]?.id, 'pytorch-2.11-py312-cu124')
assert.equal(cat.resources[0]?.affordable, true)
assert.equal(cat.resources[1]?.isFullLoad, true)
assert.equal(cat.resources[1]?.gpuSummary, '8x h800')
const cpuOnly = await runner.catalog('CPU')
assert.equal(cpuOnly.runtimes.length, 1, 'device filter keeps only CPU images')

const dispatch = await runner.dispatch({ runtime: 'pytorch-2.11-py312-cu124', resource: 'a100-1', command: 'python train.py' })
assert.equal(dispatch.jobId, 'job123')
assert.equal(dispatch.status, 'CREATED')
assert.equal((lastCreateVariables?.input as Record<string, unknown>).mode, 'TASK')

const status = await runner.status('job123')
assert.equal(status.status, 'RUNNING')
assert.equal(status.password, 'supersecret', 'runner keeps the secret for the exec path; the tool layer redacts it')

const jobs = await runner.listJobs()
assert.equal(jobs[0]?.id, 'job1')

const execRes = await runner.exec('job123', 'nvidia-smi')
assert.equal(execRes.stdout, 'gpu ok\n')
assert.equal(execCapture?.host, 'ssh.openbayes.com')
assert.equal(execCapture?.port, 22001)
assert.equal(execCapture?.command, 'nvidia-smi')

const stopped = await runner.stop('job123')
assert.equal(stopped.status, 'CANCELLING')

// exec without a configured remote fails cleanly
const noExec = new Task2DockerRunner(transport, { defaultResource: '', defaultRuntime: '' })
await assert.rejects(() => noExec.exec('job123', 'ls'), /not available in this deployment/)

// a locked/no-username account fails at bootstrap
const anonTransport: GraphQLTransport = { async execute<T>() { return { me: { displayName: 'svc' } } as T } }
await assert.rejects(() => new Task2DockerRunner(anonTransport, { defaultResource: '', defaultRuntime: '' }).whoami(), /no username/)

// --- skill boot safety ------------------------------------------------------
assert.ok(!SKILL_BODY.includes('`'), 'SKILL_BODY must not contain raw backticks')
for (const tool of ['t2d_whoami', 't2d_catalog', 't2d_dispatch', 't2d_status', 't2d_exec', 't2d_stop']) {
  assert.ok(SKILL_BODY.includes(tool), `skill body walks through ${tool}`)
}
assert.ok(SKILL_BODY.includes('/output') && SKILL_BODY.includes('/input'), 'skill covers container paths')

// --- typed error surface ----------------------------------------------------
assert.ok(new Task2DockerError('x').actionable)

console.log('smoke: all task2docker assertions passed')
