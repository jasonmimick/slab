# slab — the localhost hyperscaler

Tiny local PaaS for the AI-agent era: containers + Postgres + HTTP + secrets,
deployed on your own hardware, driven by a CLI or by AI agents over MCP.

```
slab deploy ./myapp          # slab.toml + Dockerfile (or image=) -> running app
curl http://myapp.localhost:8080
```

## Primitives
- **Apps** — durable records (name, secrets, URL, DB); containers are disposable, attached by label `slab.app=<name>`.
- **slab.toml** — `name`, `type` (`service` = always-on, `function` = scale-to-zero with wake-on-request), `port`, `image` (prebuilt) *or* Dockerfile build, `postgres = true` for an injected `DATABASE_URL`, `secrets`, `env`, `idle_timeout`.
- **Ingress** — one proxy (`:8080`) routes `<app>.localhost` by Host header; sleeping functions cold-start in ~300ms.
- **Secrets** — `slab secret set app KEY=VALUE`; injected as env at deploy.
- **Postgres** — one shared `slab-postgres` container, one database per app.
- **MCP** — `dist/mcp.js` over stdio; agents get slab_create/deploy/logs/secret_set/url/... as first-class tools.

## Run
```
npm run build
node dist/daemon.js          # API :7766, ingress :8080
node dist/cli.js list
```

## Status
v0 (weekend spike). Dogfooding target: the ~/business simulators (paysim first).
Roadmap sketches: Cloudflare Tunnel for public URLs, TTL/budget guardrails,
`slab promote <app> --to fly|cloudrun` rendering the same manifest to cloud targets.
