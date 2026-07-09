// slab — provider contract + registry (docs/design/providers.md, phase 1).
//
// A provider renders slab workloads onto a substrate other than this node's
// Docker engine. Design rules:
//   - wire-safe: JSON-serializable inputs/outputs only (survives the v1.0
//     move to out-of-process plugins)
//   - opaque refs + endpoints, never container ids / host ports
//   - capabilities declared, daemon feature-gates the rest with clear errors
//   - NO credentials held by slab: implementations use the operator's own
//     tooling/identity (e.g. the aws CLI with their profile / SSO / instance
//     role) — everything runs in the user's account, on their bill.
import { AppRecord } from '../types'

export interface ProviderCapabilities {
  functions: boolean   // scale-to-zero + wake-on-request
  jobs: boolean
  systems: boolean     // member isolation + name resolution
  postgres: boolean
}

export interface Provider {
  name: string
  capabilities: ProviderCapabilities

  // Throws with an actionable message when the substrate isn't usable
  // (CLI missing, no credentials, wrong region…). Called before any deploy.
  ready(): Promise<void>

  // Builds happen locally (every node has Docker); providers that can't see
  // the local image store push it somewhere they can pull from and return
  // the remote ref.
  prepareImage(app: AppRecord, localTag: string): Promise<string>

  // Optional: own the WHOLE image story (build/pull/push) when the substrate
  // has constraints the default flow can't express — e.g. aws needs amd64 in
  // ECR for App Runner/Lambda regardless of the local machine's arch.
  resolveImage?(app: AppRecord): Promise<string>

  deploy(app: AppRecord, image: string, env: Record<string, string>): Promise<{ ref: string; endpoint: string | null }>
  stop(app: AppRecord): Promise<void>
  start(app: AppRecord): Promise<{ endpoint: string | null }>
  remove(app: AppRecord): Promise<void>
  status(app: AppRecord): Promise<{ state: 'running' | 'stopped' | 'unknown'; endpoint?: string | null }>
  logs(app: AppRecord, tail: number): Promise<string>
}

type ProviderFactory = () => Provider
const factories: Record<string, ProviderFactory> = {}
const instances: Record<string, Provider> = {}

export function registerProvider(name: string, factory: ProviderFactory): void {
  factories[name] = factory
}

export function getProvider(name: string): Provider {
  if (!factories[name]) {
    const known = ['docker', ...Object.keys(factories)].join(', ')
    throw new Error(`unknown target "${name}" — known targets: ${known}`)
  }
  return (instances[name] ??= factories[name]())
}

export function isProviderTarget(target: string | undefined): boolean {
  return !!target && target !== 'docker'
}
