# getting started

## prerequisites

- **Node 20+** — slab is a TypeScript/Node project (`npm run build` uses
  `tsc`; the CLI and daemon run on plain Node afterward).
- **Docker** — slab drives containers through the local Docker socket
  (via `dockerode`). Docker Desktop or an equivalent daemon must be running.
- **cloudflared** (optional) — only needed for `slab expose`. Install it with
  `brew install cloudflared`. Nothing else uses it.

## starting the daemon

The daemon is one process that serves the HTTP API on `:7766` and the
ingress proxy on `:8080`.

```
npm install
npm run build
node dist/daemon.js
```

or, once the CLI is built, run it through the CLI wrapper — `slab daemon`
just does `await import('./daemon.js')`, so it's the same process, no extra
indirection:

```
node dist/cli.js daemon
```

On startup the daemon reads `~/.slab/state.json`, reconciles it against
whatever Docker actually reports (containers may have died or been removed
since the last run), and reopens tunnels for any app previously marked
`exposed`. It then binds the API and proxy.

Leave it running in a terminal (or under a process supervisor); the CLI and
MCP server are just HTTP clients against it and will tell you to `slab
daemon` if it isn't reachable.

## writing your first slab.toml

Every app is a directory containing a `slab.toml` manifest, plus either a
`Dockerfile` or an `image =` line. `slab init` scaffolds a starting point:

```
cd myapp/
node /path/to/slab/dist/cli.js init
# wrote /path/to/myapp/slab.toml
```

**Dockerfile variant** — put a `Dockerfile` next to `slab.toml`:

```toml
name = "hello-service"
type = "service"
port = 3000
```

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY . .
CMD ["node", "server.js"]
```

**Prebuilt image variant** — skip the Dockerfile entirely:

```toml
name = "hello-fn"
type = "function"
image = "nginx:alpine"
port = 80
idle_timeout = "1m"
```

If neither `image` nor a `Dockerfile` is present, `slab deploy` fails fast
with an error naming the missing piece. See
[docs/manifest.md](manifest.md) for the full field reference.

## deploying

```
node dist/cli.js deploy ./myapp        # from a source directory
node dist/cli.js deploy owner/repo     # from a git URL/shorthand — cloned first
node dist/cli.js deploy hello-service  # redeploy an already-registered app by name
```

`deploy` creates the app record if it doesn't exist yet (reading
`slab.toml`), builds the image (or pulls it), and starts the container. A
successful deploy prints the app's URL and version:

```
deployed hello-service -> http://hello-service.localhost:8080 (v1)
```

Each deploy increments `version` and replaces the previous container for
that app.

## routes

The ingress proxy on `:8080` routes purely by `Host` header:
`<name>.localhost:8080` (or `<name>.slab:8080`) is forwarded to the app's
allocated host port. There's no path-based routing — one app, one hostname.
Unknown hostnames get a `404 {"error":"unknown app"}`.

```
curl http://hello-service.localhost:8080/
```

## logs

```
node dist/cli.js logs hello-service
node dist/cli.js logs hello-service -n 500
```

Logs are pulled live from Docker (stdout + stderr, timestamped) each time
you ask — nothing is persisted by slab itself. `--tail` defaults to 100 and
is capped at 1000 by the daemon.

## secrets

```
node dist/cli.js secret set hello-service API_KEY=sk-123 OTHER=val
node dist/cli.js secret ls hello-service
```

Secret values are stored outside the manifest, in
`~/.slab/secrets/<app>.json` (`chmod 600`), and only key names are ever
returned by the CLI, the API, or the MCP tools — never values.

**Setting a secret does not restart the running container.** Env vars are
only injected at container creation, which happens during `deploy`. After
`secret set`, run `slab deploy <name>` again for the new value to take
effect.

## expose / hide

```
node dist/cli.js expose hello-service
# exposed hello-service -> https://random-words-here.trycloudflare.com
node dist/cli.js hide hello-service
```

`expose` spawns a `cloudflared` quick tunnel pointed at the ingress proxy
with the right `Host` header baked in, so hostname routing (and
wake-on-request for functions) still works through the tunnel. No
Cloudflare account or domain needed. The URL is reassigned every time the
tunnel opens — including automatically on daemon restart for any app that
was left exposed — so treat it as ephemeral.

## function scale-to-zero

Apps with `type = "function"` are stopped (not removed) after
`idle_timeout` with no incoming requests — checked every 30s by the
daemon's idle reaper. Default `idle_timeout` is `5m` if omitted; format is
`<number><unit>` with unit `s`, `m`, or `h` (e.g. `30s`, `5m`, `1h`).

When a request arrives for a sleeping function, the ingress proxy starts
its container and polls the app's port until it answers HTTP before
forwarding the original request — no manual wake step. Cold-start latency
depends entirely on the image (a static nginx wakes fast; anything with a
slow boot sequence takes longer); the proxy gives up and returns a `502`
after 15 seconds of no response. Services never sleep — they always run
with a Docker restart policy of `unless-stopped`.

## removing apps

```
node dist/cli.js rm hello-service
```

This stops and removes the container, deletes the app's secrets file, and
drops the record from `~/.slab/state.json`. It does not touch a git
checkout under `~/.slab/repos` if the app was git-sourced.

## where state lives

Everything slab tracks lives under `~/.slab` (override with the `SLAB_DIR`
env var):

- **`state.json`** — every `AppRecord`: manifest, allocated host port,
  container id, version, state, timestamps, exposed/publicUrl. Written
  atomically (write to `.tmp`, then rename).
- **`secrets/<app>.json`** — one file per app, `chmod 600`, plaintext KEY/VALUE
  pairs merged in on each `secret set`.
- **`repos/<name>`** — shallow git clones (`--depth 1`) for git-sourced apps,
  updated with `git pull --ff-only` on every redeploy.
