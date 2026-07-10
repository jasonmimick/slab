// slabd — the Go slab daemon. Parity ladder (scripts/conformance.js is the
// gate; run with DAEMON_CMD="go/bin/slabd"):
//
//	rung 0  manifest parsing            ✓ internal/manifest
//	rung 1  state + engine + app lifecycle + ingress/wake
//	rung 2  systems: networks, wires, private members
//	rung 3  jobs
//	rung 4  trunks, peers, fleet
//	rung 5  tunnels, MCP, providers, dashboard
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "slabd (go) — pre-parity skeleton; the TS daemon is the one that runs racks today")
	os.Exit(1)
}
