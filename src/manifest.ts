import fs from 'fs'
import path from 'path'
import { parse } from 'smol-toml'
import { Manifest } from './types'

const NAME_RE = /^[a-z][a-z0-9-]{1,30}$/

export function loadManifest(sourceDir: string): Manifest {
  const file = path.join(sourceDir, 'slab.toml')
  if (!fs.existsSync(file)) {
    throw new Error(`No slab.toml found in ${sourceDir}`)
  }
  const raw = parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>

  const name = String(raw.name ?? '')
  if (!NAME_RE.test(name)) {
    throw new Error(`Invalid app name "${name}" — lowercase letters, digits, hyphens, 2-31 chars`)
  }
  const type = raw.type === 'function' ? 'function' : 'service'
  const port = Number(raw.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port "${raw.port}" in slab.toml`)
  }
  const image = raw.image != null ? String(raw.image) : undefined
  if (!image && !fs.existsSync(path.join(sourceDir, 'Dockerfile'))) {
    throw new Error(`${sourceDir} has neither an "image" in slab.toml nor a Dockerfile`)
  }

  return {
    name,
    type,
    port,
    image,
    postgres: raw.postgres === true,
    secrets: Array.isArray(raw.secrets) ? raw.secrets.map(String) : [],
    idle_timeout: raw.idle_timeout != null ? String(raw.idle_timeout) : '5m',
    env: typeof raw.env === 'object' && raw.env !== null
      ? Object.fromEntries(Object.entries(raw.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      : {},
  }
}

// "5m" | "30s" | "1h" -> milliseconds
export function parseDuration(s: string): number {
  const m = /^(\d+)(s|m|h)$/.exec(s.trim())
  if (!m) return 5 * 60 * 1000
  const n = Number(m[1])
  return m[2] === 's' ? n * 1000 : m[2] === 'm' ? n * 60_000 : n * 3_600_000
}
