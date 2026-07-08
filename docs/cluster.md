# cluster — a bunch of slabs, one hyperscaler

Every machine running the slab daemon is a **node**. Nodes are equals — no
control plane, no manager election, nothing to babysit. A cluster is just
nodes that know each other's addresses (**peers**) and share auth tokens.
Any node's dashboard or CLI is a console for the whole fleet.

## build a two-node cluster

**1. Install slab on the second machine** (one line, see the README), then
open it to the network — this persists in `~/.slab/node.json` and survives
reboots and upgrades:

```bash
# on the new machine (say, hostname "garage")
slab node open
#   dashboard: http://garage:7766/?token=<generated>
#   peer it:   slab peer add garage http://garage:7766 --token <generated>
```

`slab node open --token <t>` reuses a token you already standardized on;
`--advertise <host>` sets what other machines dial (default is fine on a
LAN; on a tailnet use the tailnet name). `slab node close` reverts to
loopback-only. `slab node token --rotate` refreshes the secret.

**2. Register it on your first machine** (paste the printed line):

```bash
slab peer add garage http://garage.local:7766 --token <t>
```

Hostnames are fine everywhere — `.local` mDNS names are resolved by the
daemon on the host before trunk containers ever see them. For two-way
consoles, open the first node too and `slab peer add` it on the second.

**Transport note:** on a home LAN this works as-is. Across networks, run a
tailnet (Tailscale) — encrypted, stable names, nothing on the public
internet. The auth model: loopback is always trusted; everything else needs
the bearer token.

## what a cluster gives you

**The solar system.** The dashboard's zoom-out (▦) shows every node as a
band — a glowing sun badge per node (amber = answering, red = down, shown
honestly), its systems as tiles with live status. Local tiles fly into the
rack; remote ones open that node's dashboard.

**Remote dashboards.** Open `http://<node>:7766/?token=<t>` once — the
daemon hands your browser a session cookie, and from then on plain visits
and refreshes just work.

**`--node` targeting.** Any command, any node, no SSH:

```bash
slab --node garage deploy owner/repo
slab --node garage logs api -n 200
slab --node garage list
```

Machine-local commands (`upgrade`, `node open/close`, …) refuse `--node`
and tell you to ssh — they touch the machine itself.

**Job scheduling.** `slab run --node any …` lands git-sourced jobs on the
node with the fewest active jobs. See [jobs.md](jobs.md).

**Systems that span machines.** Put `node = "garage"` on a member in
`system.toml` and `slab up` places it there; a per-system **trunk**
container on each node carries `http://<member>:<port>` across machines
unchanged — private members included. Full design:
[design/trunks.md](design/trunks.md).

```toml
[apps.scoreboard]
source = "https://github.com/you/scoreboard"   # git source: the peer clones it
node = "garage"
```

## operating notes

- **Upgrades:** `slab upgrade` per node (or `ssh garage 'zsh -lc "slab upgrade"'`).
  Config, peers, apps, and trunks all survive.
- **Peer registry is per-node** — each console lists the peers *it* can
  reach (`slab peer ls`); registrations aren't mirrored automatically.
- **Token rotation:** after `slab node token --rotate` on a node, re-run
  `slab peer add` for it on every node that points there.
- **Same-machine clusters** (two daemons, one box) work for testing:
  separate `SLAB_DIR` + `SLAB_PORT`/`SLAB_PROXY_PORT`; spanning systems get
  node-scoped bridges automatically.
- **A dead node degrades, never breaks:** fleet views mark it unreachable;
  `--node any` skips it; its apps resume when it returns.

## env reference

| env | default | meaning |
|---|---|---|
| `SLAB_PORT` / `SLAB_PROXY_PORT` | 7766 / 8080 | api + ingress ports |
| `SLAB_BIND` | 127.0.0.1 | bind address (managed by `slab node open/close`) |
| `SLAB_TOKEN` | — | auth for non-loopback callers |
| `SLAB_ADVERTISE` | 127.0.0.1 | address other nodes dial for trunks |
| `SLAB_DIR` | ~/.slab | state dir |
| `SLAB_DAEMON_URL` | http://127.0.0.1:7766 | CLI/MCP target override |

(Env overrides `~/.slab/node.json` for one-off runs.)
