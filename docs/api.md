# daemon HTTP API

Base URL: `http://127.0.0.1:7766` (constant `DAEMON_PORT` in
`src/types.ts`; override the client's target with `SLAB_DAEMON_URL`, the
daemon itself always binds `127.0.0.1:7766`).

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

### `GET /v1/health`

- Response `200`: `{ "status": "ok", "apps": number, "proxyPort": number }`.
  Useful as a first call to confirm the daemon is up before anything else.

## unmapped routes

Anything not matched above returns `404 { "error": "not found" }`.
