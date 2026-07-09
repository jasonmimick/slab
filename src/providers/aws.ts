// slab — aws provider. One target, three substrates, routed by the manifest's
// own intent (the user never picks an AWS service):
//
//   type = "service" (public)  -> App Runner   stable random https url, pause/resume
//   type = "function"          -> Lambda       container image + Function URL, true scale-to-zero
//   public = false             -> Fargate      BETA — vpc/system isolation story is unfinished
//
// Images: everything is built/pulled as linux/amd64 and pushed to ECR —
// App Runner and Lambda can only pull ECR, and uniform arch kills the
// CannotPullContainerError class of bugs on arm64 laptops for good.
//
// AUTH: slab holds no credentials. Every call shells out to the operator's
// own `aws` CLI (configure/SSO/env, or the EC2 instance role when the daemon
// runs in EC2). ~/.slab/providers.toml names a profile/region at most.
// In-account roles created (all slab-prefixed, standard service trust, no
// cross-account/ExternalId anything): slabEcsExecutionRole,
// slabLambdaExecutionRole, slabAppRunnerAccessRole.
import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { parse } from 'smol-toml'
import { AppRecord } from '../types'
import { slabDir } from '../state'
import { Provider } from './provider'

const ECS_EXEC_ROLE = 'slabEcsExecutionRole'
const LAMBDA_ROLE = 'slabLambdaExecutionRole'
const APPRUNNER_ROLE = 'slabAppRunnerAccessRole'
const DEPLOY_WAIT_MS = 360_000
const POLL_MS = 5_000

type Substrate = 'apprunner' | 'lambda' | 'fargate'

interface AwsConfig {
  region?: string
  profile?: string
  cluster: string
  cpu: string
  memory: string
}

function loadConfig(): AwsConfig {
  let raw: Record<string, unknown> = {}
  try {
    raw = parse(fs.readFileSync(path.join(slabDir(), 'providers.toml'), 'utf-8')) as Record<string, unknown>
  } catch { /* no config file — defaults + ambient credentials */ }
  const aws = (raw.aws ?? {}) as Record<string, unknown>
  return {
    region: aws.region != null ? String(aws.region) : undefined,
    profile: aws.profile != null ? String(aws.profile) : undefined,
    cluster: aws.cluster != null ? String(aws.cluster) : 'slab',
    cpu: aws.cpu != null ? String(aws.cpu) : '256',
    memory: aws.memory != null ? String(aws.memory) : '512',
  }
}

function run(cmd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || err.message || '').trim().split('\n').slice(0, 3).join(' ')
        reject(new Error(`${cmd} ${args.slice(0, 3).join(' ')}… failed: ${detail}`))
        return
      }
      resolve(stdout)
    })
    if (input != null && child.stdin) {
      child.stdin.write(input)
      child.stdin.end()
    }
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// Which AWS service carries this app — decided by manifest intent alone
function substrateFor(app: AppRecord): Substrate {
  if (app.manifest.type === 'function') return 'lambda'
  if (app.manifest.public === false) return 'fargate'
  return 'apprunner'
}

function parseRef(ref: string | null | undefined): { kind: Substrate | null; id: string } {
  if (!ref) return { kind: null, id: '' }
  const i = ref.indexOf(':')
  if (i < 0) return { kind: 'fargate', id: ref }   // pre-routing refs were fargate
  return { kind: ref.slice(0, i) as Substrate, id: ref.slice(i + 1) }
}

export function createAwsProvider(): Provider {
  const cfg = loadConfig()
  let region: string | null = cfg.region ?? null
  let accountId: string | null = null
  let readyChecked = false

  function base(): string[] {
    const a = ['--output', 'json', '--no-cli-pager']
    if (region) a.push('--region', region)
    if (cfg.profile) a.push('--profile', cfg.profile)
    return a
  }

  async function aws(args: string[]): Promise<any> {
    const out = await run('aws', [...args, ...base()])
    if (!out.trim()) return null
    try { return JSON.parse(out) } catch { return out }
  }

  async function awsTolerate(args: string[], pattern: RegExp): Promise<any> {
    try {
      return await aws(args)
    } catch (err) {
      if (pattern.test((err as Error).message)) return null
      throw err
    }
  }

  async function ready(): Promise<void> {
    if (readyChecked) return
    try {
      await run('aws', ['--version'])
    } catch {
      throw new Error('aws CLI not found — install it (brew install awscli) and run: aws configure')
    }
    if (!region) {
      try {
        const r = (await run('aws', ['configure', 'get', 'region', ...(cfg.profile ? ['--profile', cfg.profile] : [])])).trim()
        region = r || null
      } catch { /* fall through */ }
    }
    if (!region) {
      throw new Error('no AWS region configured — set [aws] region in ~/.slab/providers.toml or run: aws configure')
    }
    let ident: any
    try {
      ident = await aws(['sts', 'get-caller-identity'])
    } catch (err) {
      throw new Error(`AWS credentials not usable: ${(err as Error).message} — run aws configure (or set [aws] profile in ~/.slab/providers.toml)`)
    }
    accountId = ident.Account
    readyChecked = true
  }

  // ── roles: in-account, service-principal trust only ──────────────────────

  async function ensureRole(name: string, service: string, policyArn: string, description: string): Promise<string> {
    try {
      const r = await aws(['iam', 'get-role', '--role-name', name])
      return r.Role.Arn
    } catch { /* create below */ }
    const trust = JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: { Service: service }, Action: 'sts:AssumeRole' }],
    })
    const created = await aws(['iam', 'create-role', '--role-name', name,
      '--assume-role-policy-document', trust, '--description', description])
    await awsTolerate(['iam', 'attach-role-policy', '--role-name', name, '--policy-arn', policyArn], /./)
    await sleep(10_000)   // IAM propagation before first use
    return created.Role.Arn
  }

  // ── images: uniform linux/amd64 in ECR ────────────────────────────────────

  async function ensureRepo(app: AppRecord): Promise<string> {
    const name = `slab/${app.name}`
    try {
      const r = await aws(['ecr', 'describe-repositories', '--repository-names', name])
      return r.repositories[0].repositoryUri
    } catch {
      const r = await aws(['ecr', 'create-repository', '--repository-name', name])
      return r.repository.repositoryUri
    }
  }

  async function ecrLogin(): Promise<void> {
    const registry = `${accountId}.dkr.ecr.${region}.amazonaws.com`
    const pwArgs = ['ecr', 'get-login-password', '--region', region!]
    if (cfg.profile) pwArgs.push('--profile', cfg.profile)
    const password = (await run('aws', pwArgs)).trim()
    await run('docker', ['login', '--username', 'AWS', '--password-stdin', registry], password)
  }

  async function resolveImage(app: AppRecord): Promise<string> {
    await ready()
    const repoUri = await ensureRepo(app)
    await ecrLogin()
    const remote = `${repoUri}:v${app.version + 1}`
    if (app.manifest.image) {
      await run('docker', ['pull', '--platform', 'linux/amd64', app.manifest.image])
      await run('docker', ['tag', app.manifest.image, remote])
    } else {
      await run('docker', ['build', '--platform', 'linux/amd64', '-t', remote, app.sourceDir])
    }
    await run('docker', ['push', remote])
    return remote
  }

  // legacy interface method — resolveImage supersedes it for this provider
  async function prepareImage(app: AppRecord, _localTag: string): Promise<string> {
    return resolveImage(app)
  }

  // ── app runner: public services ───────────────────────────────────────────

  async function apprunnerFind(app: AppRecord): Promise<{ arn: string; status: string; url: string | null } | null> {
    const r = await aws(['apprunner', 'list-services'])
    const svc = (r.ServiceSummaryList ?? []).find((s: { ServiceName: string }) => s.ServiceName === `slab-${app.name}`)
    if (!svc) return null
    return { arn: svc.ServiceArn, status: svc.Status, url: svc.ServiceUrl ?? null }
  }

  async function apprunnerWait(arn: string, want: string[]): Promise<any> {
    const deadline = Date.now() + DEPLOY_WAIT_MS
    while (Date.now() < deadline) {
      const d = await aws(['apprunner', 'describe-service', '--service-arn', arn])
      const s = d.Service
      if (want.includes(s.Status)) return s
      if (s.Status === 'CREATE_FAILED') throw new Error('app runner service creation failed — check the AWS console for the operation log')
      await sleep(POLL_MS)
    }
    throw new Error(`app runner service did not reach ${want.join('/')} within ${DEPLOY_WAIT_MS / 1000}s`)
  }

  function apprunnerSource(app: AppRecord, image: string, env: Record<string, string>, roleArn: string) {
    return {
      ImageRepository: {
        ImageIdentifier: image,
        ImageRepositoryType: 'ECR',
        ImageConfiguration: {
          Port: String(app.manifest.port),
          RuntimeEnvironmentVariables: env,
        },
      },
      AutoDeploymentsEnabled: false,
      AuthenticationConfiguration: { AccessRoleArn: roleArn },
    }
  }

  async function apprunnerDeploy(app: AppRecord, image: string, env: Record<string, string>): Promise<{ ref: string; endpoint: string | null }> {
    const roleArn = await ensureRole(APPRUNNER_ROLE, 'build.apprunner.amazonaws.com',
      'arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess',
      'slab: lets App Runner pull slab images from ECR')
    const existing = await apprunnerFind(app)
    let arn: string
    if (existing) {
      arn = existing.arn
      if (existing.status === 'PAUSED') {
        await aws(['apprunner', 'resume-service', '--service-arn', arn])
        await apprunnerWait(arn, ['RUNNING'])
      }
      await aws(['apprunner', 'update-service', '--service-arn', arn,
        '--source-configuration', JSON.stringify(apprunnerSource(app, image, env, roleArn))])
    } else {
      const created = await aws(['apprunner', 'create-service', '--service-name', `slab-${app.name}`,
        '--source-configuration', JSON.stringify(apprunnerSource(app, image, env, roleArn)),
        '--instance-configuration', JSON.stringify({ Cpu: '0.25 vCPU', Memory: '0.5 GB' })])
      arn = created.Service.ServiceArn
    }
    const svc = await apprunnerWait(arn, ['RUNNING'])
    return { ref: `apprunner:${arn}`, endpoint: svc.ServiceUrl ? `https://${svc.ServiceUrl}` : null }
  }

  // ── lambda: functions ─────────────────────────────────────────────────────

  async function lambdaDeploy(app: AppRecord, image: string, env: Record<string, string>): Promise<{ ref: string; endpoint: string | null }> {
    console.warn(`"${app.name}": lambda containers must speak the runtime api — plain web images need the aws-lambda-web-adapter (one COPY line; docs/providers/aws.md)`)
    const roleArn = await ensureRole(LAMBDA_ROLE, 'lambda.amazonaws.com',
      'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
      'slab: lambda execution (logs)')
    const fn = `slab-${app.name}`
    // the web adapter reads PORT / AWS_LWA_PORT to find the app inside the image
    const fullEnv = { PORT: String(app.manifest.port), AWS_LWA_PORT: String(app.manifest.port), ...env }
    let exists = true
    try { await aws(['lambda', 'get-function', '--function-name', fn]) } catch { exists = false }
    if (exists) {
      await aws(['lambda', 'update-function-code', '--function-name', fn, '--image-uri', image])
      await aws(['lambda', 'wait', 'function-updated-v2', '--function-name', fn])
      await aws(['lambda', 'update-function-configuration', '--function-name', fn,
        '--cli-input-json', JSON.stringify({ FunctionName: fn, Environment: { Variables: fullEnv }, MemorySize: Number(cfg.memory), Timeout: 60 })])
      await aws(['lambda', 'wait', 'function-updated-v2', '--function-name', fn])
      await awsTolerate(['lambda', 'delete-function-concurrency', '--function-name', fn], /./)   // was stopped? wake it
    } else {
      await aws(['lambda', 'create-function', '--cli-input-json', JSON.stringify({
        FunctionName: fn,
        PackageType: 'Image',
        Code: { ImageUri: image },
        Role: roleArn,
        MemorySize: Number(cfg.memory),
        Timeout: 60,
        Environment: { Variables: fullEnv },
        Architectures: ['x86_64'],
      })])
      await aws(['lambda', 'wait', 'function-active-v2', '--function-name', fn])
    }
    await awsTolerate(['lambda', 'create-function-url-config', '--function-name', fn, '--auth-type', 'NONE'], /exists/i)
    await awsTolerate(['lambda', 'add-permission', '--function-name', fn, '--statement-id', 'slab-url',
      '--action', 'lambda:InvokeFunctionUrl', '--principal', '*', '--function-url-auth-type', 'NONE'], /exists|Conflict/i)
    const url = await aws(['lambda', 'get-function-url-config', '--function-name', fn])
    const endpoint = url?.FunctionUrl ? String(url.FunctionUrl).replace(/\/$/, '') : null
    return { ref: `lambda:${fn}`, endpoint }
  }

  // ── fargate: public = false (BETA — kept for the future systems story) ────

  async function fargateEnsureCluster(): Promise<void> {
    await aws(['ecs', 'create-cluster', '--cluster-name', cfg.cluster])
  }

  async function fargateEnsureLogGroup(app: AppRecord): Promise<string> {
    const name = `/slab/${app.name}`
    await awsTolerate(['logs', 'create-log-group', '--log-group-name', name], /ResourceAlreadyExists/)
    return name
  }

  async function defaultVpc(): Promise<string> {
    const r = await aws(['ec2', 'describe-vpcs', '--filters', 'Name=is-default,Values=true'])
    const vpc = r.Vpcs?.[0]?.VpcId
    if (!vpc) throw new Error('no default VPC in this region — the fargate (public=false) beta uses the default VPC')
    return vpc
  }

  async function fargateSecurityGroup(port: number): Promise<string> {
    const vpc = await defaultVpc()
    const name = `slab-${port}`
    const found = await aws(['ec2', 'describe-security-groups', '--filters',
      `Name=group-name,Values=${name}`, `Name=vpc-id,Values=${vpc}`])
    let sgId = found.SecurityGroups?.[0]?.GroupId
    if (!sgId) {
      const created = await aws(['ec2', 'create-security-group', '--group-name', name,
        '--description', `slab: ingress on ${port}`, '--vpc-id', vpc])
      sgId = created.GroupId
    }
    await awsTolerate(['ec2', 'authorize-security-group-ingress', '--group-id', sgId,
      '--protocol', 'tcp', '--port', String(port), '--cidr', '0.0.0.0/0'], /Duplicate/)
    return sgId
  }

  async function defaultSubnets(): Promise<string[]> {
    const vpc = await defaultVpc()
    const r = await aws(['ec2', 'describe-subnets', '--filters', `Name=vpc-id,Values=${vpc}`, 'Name=default-for-az,Values=true'])
    const ids = (r.Subnets ?? []).map((s: { SubnetId: string }) => s.SubnetId)
    if (!ids.length) throw new Error('no default subnets found in the default VPC')
    return ids.slice(0, 3)
  }

  async function fargateTaskDef(app: AppRecord, image: string, env: Record<string, string>, roleArn: string, logGroup: string): Promise<string> {
    const def = {
      family: `slab-${app.name}`,
      requiresCompatibilities: ['FARGATE'],
      networkMode: 'awsvpc',
      cpu: cfg.cpu,
      memory: cfg.memory,
      executionRoleArn: roleArn,
      runtimePlatform: { cpuArchitecture: 'X86_64', operatingSystemFamily: 'LINUX' },   // images are uniformly amd64
      containerDefinitions: [{
        name: app.name,
        image,
        essential: true,
        portMappings: [{ containerPort: app.manifest.port, protocol: 'tcp' }],
        environment: Object.entries(env).map(([name, value]) => ({ name, value })),
        logConfiguration: {
          logDriver: 'awslogs',
          options: { 'awslogs-group': logGroup, 'awslogs-region': region!, 'awslogs-stream-prefix': 'slab' },
        },
      }],
    }
    const r = await aws(['ecs', 'register-task-definition', '--cli-input-json', JSON.stringify(def)])
    return r.taskDefinition.taskDefinitionArn
  }

  async function fargateServiceState(app: AppRecord): Promise<{ exists: boolean; running: number }> {
    const r = await aws(['ecs', 'describe-services', '--cluster', cfg.cluster, '--services', `slab-${app.name}`])
    const svc = (r.services ?? []).find((s: { status: string }) => s.status !== 'INACTIVE')
    return svc ? { exists: true, running: svc.runningCount ?? 0 } : { exists: false, running: 0 }
  }

  async function fargateEndpoint(app: AppRecord): Promise<string | null> {
    const tasks = await aws(['ecs', 'list-tasks', '--cluster', cfg.cluster, '--service-name', `slab-${app.name}`, '--desired-status', 'RUNNING'])
    const arn = tasks.taskArns?.[0]
    if (!arn) return null
    const d = await aws(['ecs', 'describe-tasks', '--cluster', cfg.cluster, '--tasks', arn])
    const task = d.tasks?.[0]
    if (!task || task.lastStatus !== 'RUNNING') return null
    const eni = task.attachments?.flatMap((a: { details?: Array<{ name: string; value: string }> }) => a.details ?? [])
      .find((x: { name: string }) => x.name === 'networkInterfaceId')?.value
    if (!eni) return null
    const ni = await aws(['ec2', 'describe-network-interfaces', '--network-interface-ids', eni])
    const ip = ni.NetworkInterfaces?.[0]?.Association?.PublicIp
    return ip ? `${ip}:${app.manifest.port}` : null
  }

  async function fargateDeploy(app: AppRecord, image: string, env: Record<string, string>): Promise<{ ref: string; endpoint: string | null }> {
    console.warn(`"${app.name}": public=false on aws runs on fargate — BETA, the isolation/systems story is unfinished`)
    await fargateEnsureCluster()
    const roleArn = await ensureRole(ECS_EXEC_ROLE, 'ecs-tasks.amazonaws.com',
      'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',
      'slab: lets Fargate pull ECR images and write CloudWatch logs')
    const logGroup = await fargateEnsureLogGroup(app)
    const taskDefArn = await fargateTaskDef(app, image, env, roleArn, logGroup)
    const sg = await fargateSecurityGroup(app.manifest.port)
    const subnets = await defaultSubnets()
    const netCfg = `awsvpcConfiguration={subnets=[${subnets.join(',')}],securityGroups=[${sg}],assignPublicIp=ENABLED}`
    const svc = await fargateServiceState(app)
    if (svc.exists) {
      await aws(['ecs', 'update-service', '--cluster', cfg.cluster, '--service', `slab-${app.name}`,
        '--task-definition', taskDefArn, '--desired-count', '1', '--network-configuration', netCfg])
    } else {
      await aws(['ecs', 'create-service', '--cluster', cfg.cluster, '--service-name', `slab-${app.name}`,
        '--task-definition', taskDefArn, '--desired-count', '1', '--launch-type', 'FARGATE',
        '--network-configuration', netCfg])
    }
    const deadline = Date.now() + DEPLOY_WAIT_MS
    let endpoint: string | null = null
    while (Date.now() < deadline && !endpoint) {
      endpoint = await fargateEndpoint(app)
      if (!endpoint) await sleep(POLL_MS)
    }
    return { ref: `fargate:${cfg.cluster}/slab-${app.name}`, endpoint }
  }

  // ── the router ────────────────────────────────────────────────────────────

  async function deploy(app: AppRecord, image: string, env: Record<string, string>): Promise<{ ref: string; endpoint: string | null }> {
    await ready()
    const want = substrateFor(app)
    const prev = parseRef(app.ref)
    if (prev.kind && prev.kind !== want) {
      // manifest intent changed (e.g. service -> function): retire the old home
      await removeOn(prev.kind, app).catch(() => { /* best-effort */ })
    }
    if (want === 'apprunner') return apprunnerDeploy(app, image, env)
    if (want === 'lambda') return lambdaDeploy(app, image, env)
    return fargateDeploy(app, image, env)
  }

  async function removeOn(kind: Substrate, app: AppRecord): Promise<void> {
    if (kind === 'apprunner') {
      const svc = await apprunnerFind(app)
      if (svc) await aws(['apprunner', 'delete-service', '--service-arn', svc.arn])
    } else if (kind === 'lambda') {
      await awsTolerate(['lambda', 'delete-function', '--function-name', `slab-${app.name}`], /ResourceNotFound/)
    } else {
      await awsTolerate(['ecs', 'update-service', '--cluster', cfg.cluster, '--service', `slab-${app.name}`, '--desired-count', '0'], /ServiceNotFound|ClusterNotFound/)
      await awsTolerate(['ecs', 'delete-service', '--cluster', cfg.cluster, '--service', `slab-${app.name}`, '--force'], /ServiceNotFound|ClusterNotFound/)
    }
  }

  async function stop(app: AppRecord): Promise<void> {
    await ready()
    const { kind } = parseRef(app.ref)
    if (kind === 'apprunner') {
      const svc = await apprunnerFind(app)
      if (svc) {
        await aws(['apprunner', 'pause-service', '--service-arn', svc.arn])
        await apprunnerWait(svc.arn, ['PAUSED'])
      }
    } else if (kind === 'lambda') {
      await aws(['lambda', 'put-function-concurrency', '--function-name', `slab-${app.name}`, '--reserved-concurrent-executions', '0'])
    } else {
      await aws(['ecs', 'update-service', '--cluster', cfg.cluster, '--service', `slab-${app.name}`, '--desired-count', '0'])
    }
  }

  async function start(app: AppRecord): Promise<{ endpoint: string | null }> {
    await ready()
    const { kind } = parseRef(app.ref)
    if (kind === 'apprunner') {
      const svc = await apprunnerFind(app)
      if (!svc) return { endpoint: null }
      await aws(['apprunner', 'resume-service', '--service-arn', svc.arn])
      const s = await apprunnerWait(svc.arn, ['RUNNING'])
      return { endpoint: s.ServiceUrl ? `https://${s.ServiceUrl}` : null }
    }
    if (kind === 'lambda') {
      await awsTolerate(['lambda', 'delete-function-concurrency', '--function-name', `slab-${app.name}`], /ResourceNotFound/)
      return { endpoint: app.endpoint ?? null }
    }
    await aws(['ecs', 'update-service', '--cluster', cfg.cluster, '--service', `slab-${app.name}`, '--desired-count', '1'])
    const deadline = Date.now() + DEPLOY_WAIT_MS
    while (Date.now() < deadline) {
      const ep = await fargateEndpoint(app)
      if (ep) return { endpoint: ep }
      await sleep(POLL_MS)
    }
    return { endpoint: null }
  }

  async function remove(app: AppRecord): Promise<void> {
    await ready()
    const { kind } = parseRef(app.ref)
    await removeOn(kind ?? substrateFor(app), app)
  }

  async function status(app: AppRecord): Promise<{ state: 'running' | 'stopped' | 'unknown'; endpoint?: string | null }> {
    await ready()
    const { kind } = parseRef(app.ref)
    try {
      if (kind === 'apprunner') {
        const svc = await apprunnerFind(app)
        if (!svc) return { state: 'unknown' }
        if (svc.status === 'RUNNING') return { state: 'running', endpoint: svc.url ? `https://${svc.url}` : app.endpoint ?? null }
        if (svc.status === 'PAUSED') return { state: 'stopped' }
        return { state: 'unknown' }
      }
      if (kind === 'lambda') {
        try {
          const c = await aws(['lambda', 'get-function-concurrency', '--function-name', `slab-${app.name}`])
          if (c?.ReservedConcurrentExecutions === 0) return { state: 'stopped' }
        } catch { /* no reserved concurrency set — it's live */ }
        await aws(['lambda', 'get-function', '--function-name', `slab-${app.name}`])
        return { state: 'running', endpoint: app.endpoint ?? null }
      }
      const svc = await fargateServiceState(app)
      if (!svc.exists) return { state: 'unknown' }
      if (svc.running > 0) return { state: 'running', endpoint: await fargateEndpoint(app) }
      return { state: 'stopped' }
    } catch {
      return { state: 'unknown' }
    }
  }

  async function logGroupFor(app: AppRecord): Promise<string | null> {
    const { kind } = parseRef(app.ref)
    if (kind === 'lambda') return `/aws/lambda/slab-${app.name}`
    if (kind === 'apprunner') {
      const svc = await apprunnerFind(app)
      if (!svc) return null
      const id = svc.arn.split('/').pop()
      return `/aws/apprunner/slab-${app.name}/${id}/application`
    }
    return `/slab/${app.name}`
  }

  async function logs(app: AppRecord, tail: number): Promise<string> {
    await ready()
    try {
      const group = await logGroupFor(app)
      if (!group) return 'no logs: service not found'
      const r = await aws(['logs', 'filter-log-events', '--log-group-name', group, '--limit', String(Math.min(1000, tail))])
      const events = (r.events ?? []) as Array<{ timestamp: number; message: string }>
      return events
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((e) => `${new Date(e.timestamp).toISOString()} ${e.message}`)
        .join('\n')
    } catch (err) {
      return `no logs yet: ${(err as Error).message}`
    }
  }

  return {
    name: 'aws',
    capabilities: { functions: true, jobs: false, systems: false, postgres: false },
    ready,
    prepareImage,
    resolveImage,
    deploy,
    stop,
    start,
    remove,
    status,
    logs,
  }
}
