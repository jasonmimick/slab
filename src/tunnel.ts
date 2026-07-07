// Cloudflare quick tunnels — free public HTTPS URLs, no account or domain.
// One cloudflared child per exposed app, pointed at the slab ingress proxy
// with --http-host-header so hostname routing (and wake-on-request) still work.
import { spawn, ChildProcess } from 'child_process'
import { AppRecord, PROXY_PORT } from './types'

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/

interface Tunnel {
  proc: ChildProcess
  url: string
}

const tunnels = new Map<string, Tunnel>()

// Spawns cloudflared for the app and resolves with the assigned public URL.
export function openTunnel(app: AppRecord): Promise<string> {
  closeTunnel(app.name)
  return new Promise((resolve, reject) => {
    const proc = spawn('cloudflared', [
      'tunnel',
      '--url', `http://127.0.0.1:${PROXY_PORT}`,
      '--http-host-header', `${app.name}.localhost`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })

    const timeout = setTimeout(() => {
      proc.kill()
      reject(new Error('cloudflared did not report a URL within 30s'))
    }, 30_000)

    let buf = ''
    const onData = (chunk: Buffer) => {
      buf += chunk.toString()
      const m = URL_RE.exec(buf)
      if (m) {
        clearTimeout(timeout)
        tunnels.set(app.name, { proc, url: m[0] })
        resolve(m[0])
      }
    }
    // cloudflared logs the assigned URL to stderr
    proc.stderr?.on('data', onData)
    proc.stdout?.on('data', onData)

    proc.on('exit', (code) => {
      clearTimeout(timeout)
      tunnels.delete(app.name)
      if (!URL_RE.test(buf)) {
        reject(new Error(`cloudflared exited (code ${code}) before reporting a URL`))
      }
    })
    proc.on('error', (err) => {
      clearTimeout(timeout)
      reject(new Error(`failed to spawn cloudflared: ${err.message} — brew install cloudflared`))
    })
  })
}

export function closeTunnel(appName: string): void {
  const t = tunnels.get(appName)
  if (t) {
    t.proc.kill()
    tunnels.delete(appName)
  }
}

export function tunnelUrl(appName: string): string | null {
  return tunnels.get(appName)?.url ?? null
}

export function closeAllTunnels(): void {
  for (const name of Array.from(tunnels.keys())) closeTunnel(name)
}
