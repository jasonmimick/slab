# daemon HTTP API

Base URL: `http://127.0.0.1:7766` (constant `DAEMON_PORT` in
`src/types.ts`; override the client's target with `SLAB_DAEMON_URL`; the
daemon binds `SLAB_BIND` (default `127.0.0.1`) on port `SLAB_PORT`
(default `7766`)).

## auth

Loopback requests are always trusted. Non-loopback requests (a daemon bound
to `0.0.0.0` on a LAN/tailnet — `slab node open`) require
`Authorization: Bearer $SLAB_TOKEN`, or `?token=$SLAB_TOKEN` once — the
daemon answers that with an HttpOnly session cookie (port-scoped,
`slab_token_<port>`), so browser refreshes and navigation keep working
after the dashboard strips the token from the URL. With no `SLAB_TOKEN`
set, non-loopback requests are always rejected.

All request and response bodies are JSON. Every error response is
`{ "error": string }` with a 4xx or 5xx status — there is no other error
shape anywhere in the API.

The ingress proxy is a **separate** server on port `8080` (constant
`PROXY_PORT`) that routes application traffic by `Host` header
(`<app>.localhost` / `<app>.slab` → the app's container). It is not part of
this API; see [getting-started.md](getting-started.md#routes).

`GET /` on the daemon port (`7766`) serves the HTML control-plane
dashboard, not JSON.

## routes

### `GET /v1/apps`

List every registered app.

- Response `200`: `{ "apps": AppRecord[] }` — each record also carries a
  computed `reqPerMin` (requests in the trailing 60s), not persisted to
  disk.

### `POST /v1/apps`

Register a new app.

- Body: `{ "sourceDir": "<absolute path>" }` **or** `{ "gitUrl": "<url>" }`.
  A git URL is cloned to `~/.slab/repos/<name>` first (shorthand like
  `owner/repo` is expanded to `https://github.com/owner/repo.git`).
  `slab.toml` is read from the resulting directory to get the app's real
  `name`.
- Response `201`: `{ "app": AppRecord }`.
- Errors: `400` if the body is malformed, the git clone fails, or
  `slab.toml` is missing/invalid; `409` if an app with that name already
  exists.

### `GET /v1/apps/:name`

- Response `200`: `{ "app": AppRecord }`.
- Errors: `404` if unknown.

### `DELETE /v1/apps/:name`

Stop and remove the app's container, delete its secrets file, and drop its
record. Also closes any open tunnel.

- Response: `204`, empty body.
- Errors: `404` if unknown.

### `POST /v1/apps/:name/deploy`

Build (or pull) the image and (re)start the container. For git-sourced
apps, pulls the latest commit and re-reads `slab.toml` first. Increments
`version` on success.

- Response `200`: `{ "app": AppRecord }` (state `"running"`).
- Response `500`: `{ "error": string }` on build/run failure — the app
  record's `state` is set to `"error"` and its `error` field populated, but
  the HTTP response here is the error shape, not the app.
- Errors: `404` if unknown.

### `POST /v1/apps/:name/stop`

Stop the container, keep it (and the record) around.

- Response `200`: `{ "app": AppRecord }` (state `"stopped"`).
- Errors: `404` if unknown.

### `POST /v1/apps/:name/start`

Start an existing stopped container without rebuilding.

- Response `200`: `{ "app": AppRecord }` (state `"running"`).
- Errors: `404` if unknown; the underlying start also fails if no container
  exists yet for the app (i.e. it was never deployed).

### `GET /v1/apps/:name/logs?tail=100`

Fetch recent container logs (stdout + stderr, timestamped).

- Query: `tail` — number of lines, default `100`, capped at `1000`.
- Response `200`: `{ "logs": string }`.
- Errors: `404` if unknown.

### `PUT /v1/apps/:name/secrets`

Set (merge) one or more secret env vars.

- Body: `{ "values": Record<string, string> }`.
- Response: `204`, empty body. Values are **not** injected into a running
  container until the next `deploy`.
- Errors: `400` if `values` is missing or not an object; `404` if unknown.

### `GET /v1/apps/:name/secrets`

- Response `200`: `{ "keys": string[] }` — names only, values are never
  returned.
- Errors: `404` if unknown.

### `POST /v1/apps/:name/expose`

Open a Cloudflare quick tunnel pointed at the ingress proxy for this app.

- Response `200`: `{ "app": AppRecord }` with `publicUrl` set to a fresh
  `https://*.trycloudflare.com` URL and `exposed: true`.
- Errors: `404` if unknown; the underlying tunnel open can fail (e.g.
  `cloudflared` not installed, or no URL reported within 30s) and will
  propagate as a `500`.

### `POST /v1/apps/:name/hide`

Close the tunnel.

- Response `200`: `{ "app": AppRecord }` with `publicUrl: null` and
  `exposed: false`.
- Errors: `404` if unknown.

## systems

Apps wired together on a private network — see
[design/systems.md](design/systems.md) and, for spanning nodes,
[design/trunks.md](design/trunks.md).

### `GET /v1/systems`

- Response `200`: `{ "systems": SystemRecord[] }` — each carries a computed
  `editable` (true when the manifest is daemon-owned, i.e. created via the
  inline API, and not adopted from a peer).

### `POST /v1/systems`

Create or update a system.

- Body: `{ "sourceFile": "<abs path to system.toml>" }` **or**
  `{ "manifest": { name, apps: { <member>: { source, node? } }, wires } }` —
  the inline form (dashboard/agents) is validated identically and persisted
  to `~/.slab/systems/<name>.toml`. Unknown member apps are auto-created
  from their sources; members with `node` are created on that peer at
  deploy time.
- Response `201` (new) / `200` (update): `{ "system": SystemRecord }`.

### `POST /v1/systems/:name/deploy`

Deploy every member in wire-dependency order: local members here, placed
members pushed to their peers (adopt), then trunks started on every
involved node. Distinct member ports are enforced for spanning systems.

- Response `200`: `{ "system": SystemRecord, "apps": AppRecord[] }` (local
  members only in `apps`).

### `PUT /v1/systems/:name/wires`

Patch wires; affected local members are redeployed automatically.

- Body: `{ "set"?: { "<member>.<ENV>": value }, "remove"?: [key] }`.
- Response `200`: `{ "system", "redeployed": string[] }`.
- Errors: `409` if the system's manifest isn't daemon-owned (edit the file
  and `slab up`) or is adopted from a peer (edit on the console node);
  `400` on invalid keys.

### `DELETE /v1/systems/:name`

Removes this node's trunk, the network, and the record. Member apps are
**never** deleted.

- Response: `204`.

### node-to-node (used by the daemon itself)

`POST /v1/systems/adopt` and `POST /v1/systems/:name/trunk-sync` — a
console pushes a spanning system to a peer and synchronizes trunk configs.
Not intended for direct use.

## cluster

### `GET /v1/fleet`

This node + every registered peer, one payload (parallel fan-out, 3s bound
per peer; a dead peer degrades to `reachable: false`, never fails the
view).

- Response `200`: `{ "nodes": [{ name, self, reachable, url, proxyPort,
  apps, systems, error }] }`.

### `GET /v1/peers` · `PUT /v1/peers/:name` · `DELETE /v1/peers/:name`

The peer registry. `PUT` body: `{ "url": "http://host:7766", "token"? }`.

### `PUT /v1/node`

Rename this node. Body: `{ "name" }` (same rules as app names).

## jobs

Run-to-completion workloads (`slab run`): build (or pull) an image, run one
command, capture the exit code, keep the logs. No ports, no ingress, no
restart. Two modes:

- **Dockerfile mode** — `sourceDir`/`gitUrl` points at a directory with a
  `Dockerfile`; it is built and `command` runs in the built image.
- **image mode** — `image` names a stock image (e.g. `node:20`); it is
  pulled and the source directory (if any) is bind-mounted read-write at
  `/workspace`, which becomes the working directory.

Finished job history is capped at 50; older records and their containers
are pruned automatically.

### `GET /v1/jobs`

- Response `200`: `{ "jobs": JobRecord[] }`, newest first.

### `POST /v1/jobs`

Create a job and start it **asynchronously** — the response returns
immediately with the record in state `"queued"`; poll `GET /v1/jobs/:id`
for progress (`queued → building → running → succeeded|failed|canceled`).

- Body: `{ "sourceDir"?, "gitUrl"?, "image"?, "command"?: string[],
  "env"?: Record<string,string>, "name"?, "timeout"?, "systems"?: string[] }`
  — at least one of `sourceDir`/`gitUrl`/`image`. `timeout` is
  `"90s" | "10m" | "1h"`-style, default `30m`; the daemon kills the
  container when it expires. `systems` joins the job to those systems'
  networks before start — it reaches members (including private ones) by
  name; see [jobs.md](jobs.md#jobs-inside-systems--the-sandbox-agent-primitive).
- Response `201`: `{ "job": JobRecord }`.
- Errors: `400` on a malformed body, an unresolvable source, a missing
  Dockerfile (without `image`), or a bare `image` job with no `command`.

### `GET /v1/jobs/:id`

- Response `200`: `{ "job": JobRecord }` — `exitCode` is set once the
  container exits; `error` carries build failures / timeout messages.
- Errors: `404` if unknown.

### `GET /v1/jobs/:id/logs?tail=100`

- Response `200`: `{ "logs": string }` (stdout + stderr). Logs survive
  completion — the container is kept until the job is deleted or pruned.

### `POST /v1/jobs/:id/cancel`

Stop a queued/building/running job; it finishes in state `"canceled"`.

- Response `200`: `{ "job": JobRecord }`.
- Errors: `404` if unknown; `409` if the job already finished.

### `DELETE /v1/jobs/:id`

Remove the job's container and record.

- Response: `204`, empty body.
- Errors: `404` if unknown.

### `GET /v1/health`

- Response `200`: `{ "status": "ok", "node": string, "apps": number,
  "proxyPort": number }`. Useful as a first call to confirm the daemon is
  up before anything else. `node` is this daemon's name (defaults to the
  machine hostname; rename via `PUT /v1/node` / `slab node <name>`).

### `PUT /v1/node`

Rename this daemon node. A node is one machine running the slab daemon —
naming it is the identity groundwork for running several slabs.

- Body: `{ "name": string }` — same rules as app names
  (`^[a-z][a-z0-9-]{1,30}$`).
- Response `200`: `{ "node": string }`.
- Errors: `400` on an invalid name.

## misc

- `GET /v1/events` — server-sent events (`request`, `deploy`, `job`); the
  dashboard's live audio/visuals listen here.
- `POST /v1/play` — body `{ "seconds"? }`: rhythmic health checks across
  running apps (every note is a real request).
- `GET /v1/skins` · `GET /skins/<name>.css` — dashboard skins
  ([skins.md](skins.md)).
- `GET /` — the dashboard. `GET /favicon.svg` — the mark.

## unmapped routes

Anything not matched above returns `404 { "error": "not found" }`.
