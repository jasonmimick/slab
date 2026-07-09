# pg-cluster

A postgres cluster as a slab system: **primary + streaming replica behind
pgbouncer**, all three `public = false` — no host ports, no ingress, reachable
only by system-mates.

```
slab up examples/pg-cluster
```

```
┌─ pg-cluster ────────────────────────────────┐
│  your app ──> pgbouncer:6432 ──> pg-primary │
│                                     │ WAL   │
│                                pg-replica   │
└─────────────────────────────────────────────┘
```

## What it demonstrates

- **`volumes`** — both postgres members declare
  `volumes = ["pgdata:/bitnami/postgresql"]`, so data survives redeploys
  (without it, every deploy recreates the container and drops all data).
- **`[wires]`** — the replica learns `POSTGRESQL_MASTER_HOST` and pgbouncer
  learns `POSTGRESQL_HOST` from the system manifest, not from baked-in config.
- **private members** — nothing here is exposed; apps join the party by being
  wired to `pgbouncer:6432`.

## Using it from an app

Add your app to the system and wire its connection string:

```toml
[apps.myapp]
source = "./myapp"

[wires]
"myapp.DATABASE_URL" = "postgresql://app:apppass@pgbouncer:6432/appdb"
```

Reads that don't need to be fresh can go straight at the replica
(`pg-replica:5433`) — it's read-only. (5433 so every member port is
distinct, which is what lets this cluster join a node-spanning system.)

## Honest framing

- This is a **compose-grade** cluster: real streaming replication, one
  address for apps, data that survives redeploys. It is **not** HA — there is
  no auto-failover. If the primary dies, the replica keeps serving reads;
  "promote the replica" as an agent verb is future work.
- Credentials are inline demo values (`app`/`apppass`). That's deliberate:
  every member is private to the rack. For anything real, use `secrets`.
- Images are `bitnamilegacy/*` — Bitnami froze its Docker Hub catalog in
  2025, so these tags are stable but no longer updated. Swap in your own
  registry if you need patched images.
- Volumes are per-node: if a member lands on another node (trunks), it
  starts with an empty volume there.
