# jobs — `slab run`

A **job** is the third thing slab runs beside services and functions: a
container that runs one command to completion. Exit code propagated, logs
kept, timeout guardrail, cancelable. Tests, builds, scripts, one-off tasks,
and the sandbox for agent workflows.

## two modes

**Dockerfile mode** — the source has a `Dockerfile`; slab builds it and
runs your command in the built image:

```bash
slab run . -- npm test
slab run https://github.com/you/repo -- make ci
```

**Image mode** — skip the build; a stock image is pulled and the source is
bind-mounted read-write at `/workspace` (the working directory):

```bash
slab run . --image node:20 -- npm test
slab run . --image python:3.12 -- pytest -x
```

## behavior

- `slab run` follows the job live and **exits with the job's exit code** —
  it composes in scripts and CI. `--detach` returns immediately
  (`slab job logs <id>` to follow up).
- **Timeout** (`-t`, default `30m`): the daemon kills the container when it
  expires — agents create work faster than humans reap it.
- Ctrl-C cancels the job, not just the CLI.
- Logs survive completion; the container is kept until `slab job rm` or
  automatic pruning (history capped at 50 finished jobs).
- Env: `-e KEY=VALUE` (repeatable). Name: `--name`.

```bash
slab jobs                 # newest first: state, exit, runtime, command
slab job logs <id> -n 500
slab job cancel <id>
slab job rm <id>
```

The dashboard shows a **job bench** under the monitor deck — breathing
amber while running, green/red when done, with logs/cancel/rm.

## jobs inside systems — the sandbox-agent primitive

`--system <name>` joins the job container to a system's private network
**before it starts**, so it reaches members — including `public = false`
ones — by plain DNS name, even members living on other nodes (via trunks):

```bash
slab run --system arcade --image alpine:3 -- wget -qO- http://scoreboard:4000/health
```

This is the substrate for "hey slab, fix system X": an agent job joins the
system, probes real members over real wiring, clones member repos (every
app record carries its `gitUrl`), and calls the daemon API to redeploy.
Repeatable for multiple systems.

## jobs across nodes

With a [cluster](cluster.md):

```bash
slab --node garage run https://github.com/you/repo -- make ci   # run THERE
slab run --node any https://github.com/you/repo -- make ci      # least-busy node wins
```

`--node any` probes every node's active-job count in parallel and schedules
on the idlest; unreachable nodes are never picked. Only **git-sourced**
jobs roam (a local directory doesn't exist on peers — those stay local,
with a note).

## for agents

The MCP tool `slab_run` blocks until the job finishes and returns
`{ exitCode, logs }` in one call — ideal for agent loops. It takes the same
`systems` parameter. See [agents.md](agents.md).

## API

`POST /v1/jobs`, `GET /v1/jobs[/:id]`, logs / cancel / delete — see
[api.md](api.md#jobs).
