// Package mcpserver is the slab MCP server — the agent surface, twin of
// src/mcp.ts. Stdio JSON-RPC (newline-delimited), thin proxies onto the
// daemon HTTP API. Tool names and semantics are the contract; the
// conformance harness asserts both daemons expose the identical set.
package mcpserver

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"
)

func daemonBase() string {
	if u := os.Getenv("SLAB_URL"); u != "" {
		return strings.TrimRight(u, "/")
	}
	port := os.Getenv("SLAB_PORT")
	if port == "" {
		port = "7766"
	}
	return "http://127.0.0.1:" + port
}

// ── daemon client ───────────────────────────────────────────────────────────

var httpc = &http.Client{Timeout: 10 * time.Minute}

func call(method, path string, body any) (map[string]any, string, error) {
	var rd io.Reader
	if body != nil {
		data, _ := json.Marshal(body)
		rd = bytes.NewReader(data)
	}
	req, _ := http.NewRequest(method, daemonBase()+path, rd)
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}
	resp, err := httpc.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("cannot reach the slab daemon at %s: %s", daemonBase(), err.Error())
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var parsed map[string]any
	_ = json.Unmarshal(raw, &parsed)
	if resp.StatusCode >= 300 {
		if parsed != nil {
			if msg, ok := parsed["error"].(string); ok {
				return nil, "", fmt.Errorf("%s", msg)
			}
		}
		return nil, "", fmt.Errorf("%s %s -> %d", method, path, resp.StatusCode)
	}
	return parsed, string(raw), nil
}

// ── tool registry ───────────────────────────────────────────────────────────

type tool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
	Annotations map[string]any `json:"annotations,omitempty"`
	handler     func(args map[string]any) (any, error)
}

func obj(props map[string]any, required ...string) map[string]any {
	s := map[string]any{"type": "object", "properties": props}
	if len(required) > 0 {
		s["required"] = required
	}
	return s
}

func str(desc string) map[string]any { return map[string]any{"type": "string", "description": desc} }
func strArr(desc string) map[string]any {
	return map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": desc}
}
func strMap(desc string) map[string]any {
	return map[string]any{"type": "object", "additionalProperties": map[string]any{"type": "string"}, "description": desc}
}

func readOnly() map[string]any {
	return map[string]any{"readOnlyHint": true, "idempotentHint": true}
}

func str2(args map[string]any, key string) string {
	if v, ok := args[key].(string); ok {
		return v
	}
	return ""
}

func tools() []*tool {
	ts := []*tool{
		{
			Name:        "slab_list",
			Description: "List every app registered with slab, with its type, current state, URL, and last deploy time. Use this first to see what exists before deploying, stopping, or inspecting a specific app.",
			InputSchema: obj(map[string]any{}),
			Annotations: readOnly(),
			handler: func(args map[string]any) (any, error) {
				out, _, err := call("GET", "/v1/apps", nil)
				if err != nil {
					return nil, err
				}
				return out["apps"], nil
			},
		},
		{
			Name:        "slab_create",
			Description: "Register a new app with slab from a source directory or a git repository URL. The source must contain a slab.toml manifest (or a Dockerfile to infer one). Does not build or start the app — call slab_deploy afterward to run it.",
			InputSchema: obj(map[string]any{
				"sourceDir": str("Absolute path to the app source directory containing slab.toml"),
				"gitUrl":    str("Git repository URL (https://, git@, or shorthand owner/repo); slab clones it and pulls on each deploy"),
				"target":    str("Where the app runs: omit for local docker, or \"aws\""),
			}),
			handler: func(args map[string]any) (any, error) {
				body := map[string]any{}
				if v := str2(args, "gitUrl"); v != "" {
					body["gitUrl"] = v
				} else {
					body["sourceDir"] = str2(args, "sourceDir")
				}
				if v := str2(args, "target"); v != "" {
					body["target"] = v
				}
				out, _, err := call("POST", "/v1/apps", body)
				if err != nil {
					return nil, err
				}
				return out["app"], nil
			},
		},
		{
			Name:        "slab_deploy",
			Description: "Build and run an app on slab. Use after creating or changing an app. Pass name for a known app, sourceDir to deploy from a directory, or gitUrl to deploy straight from a git repository (auto-created and cloned if not already registered; pulled on every redeploy). Returns the app record including its URL.",
			InputSchema: obj(map[string]any{
				"name":      str("Name of an already-registered app to deploy"),
				"sourceDir": str("Absolute path to the app source directory; used to auto-create the app if not yet registered"),
				"gitUrl":    str("Git repository URL; the app is auto-created from the repo if not yet registered"),
				"target":    str("Where the app runs (applies when first created): omit for local docker, or \"aws\""),
			}),
			handler: func(args map[string]any) (any, error) {
				name := str2(args, "name")
				if name == "" {
					body := map[string]any{}
					if v := str2(args, "gitUrl"); v != "" {
						body["gitUrl"] = v
					} else if v := str2(args, "sourceDir"); v != "" {
						body["sourceDir"] = v
					} else {
						return nil, fmt.Errorf("Provide name, sourceDir, or gitUrl")
					}
					if v := str2(args, "target"); v != "" {
						body["target"] = v
					}
					out, _, err := call("POST", "/v1/apps", body)
					if err == nil {
						name = out["app"].(map[string]any)["name"].(string)
					} else if m := alreadyExists(err); m != "" {
						name = m
					} else {
						return nil, err
					}
				}
				out, _, err := call("POST", "/v1/apps/"+name+"/deploy", nil)
				if err != nil {
					return nil, err
				}
				return out["app"], nil
			},
		},
		{
			Name:        "slab_stop",
			Description: "Stop a running app's container. The app record and data are kept; use slab_start to bring it back.",
			InputSchema: obj(map[string]any{"name": str("App name")}, "name"),
			Annotations: map[string]any{"idempotentHint": true},
			handler:     appAction("stop"),
		},
		{
			Name:        "slab_start",
			Description: "Start a stopped app's existing container (no rebuild). Use slab_deploy instead when the source changed.",
			InputSchema: obj(map[string]any{"name": str("App name")}, "name"),
			Annotations: map[string]any{"idempotentHint": true},
			handler:     appAction("start"),
		},
		{
			Name:        "slab_remove",
			Description: "Remove an app: stops and deletes its container, record, and secrets. Named volumes are kept (purge manually with docker volume rm). The source directory is untouched.",
			InputSchema: obj(map[string]any{"name": str("App name")}, "name"),
			Annotations: map[string]any{"destructiveHint": true},
			handler: func(args map[string]any) (any, error) {
				_, _, err := call("DELETE", "/v1/apps/"+str2(args, "name"), nil)
				if err != nil {
					return nil, err
				}
				return map[string]any{"removed": str2(args, "name")}, nil
			},
		},
		{
			Name:        "slab_logs",
			Description: "Fetch an app's recent logs (stdout+stderr from its container). Use to debug crashes, check startup, or watch request handling.",
			InputSchema: obj(map[string]any{
				"name": str("App name"),
				"tail": map[string]any{"type": "integer", "description": "Number of trailing lines (default 200)"},
			}, "name"),
			Annotations: readOnly(),
			handler: func(args map[string]any) (any, error) {
				tail := 200
				if v, ok := args["tail"].(float64); ok && v > 0 {
					tail = int(v)
				}
				_, raw, err := call("GET", fmt.Sprintf("/v1/apps/%s/logs?tail=%d", str2(args, "name"), tail), nil)
				if err != nil {
					return nil, err
				}
				return raw, nil
			},
		},
		{
			Name:        "slab_secret_set",
			Description: "Set one or more secret env vars for an app (merged into existing secrets). Values are never returned by any tool once set. Redeploy the app for new secret values to take effect in a running container.",
			InputSchema: obj(map[string]any{
				"name":   str("App name"),
				"values": strMap("Map of secret env var name to value"),
			}, "name", "values"),
			handler: func(args map[string]any) (any, error) {
				values, _ := args["values"].(map[string]any)
				_, _, err := call("PUT", "/v1/apps/"+str2(args, "name")+"/secrets", map[string]any{"values": values})
				if err != nil {
					return nil, err
				}
				keys := make([]string, 0, len(values))
				for k := range values {
					keys = append(keys, k)
				}
				sort.Strings(keys)
				return map[string]any{"name": str2(args, "name"), "keys": keys}, nil
			},
		},
		{
			Name:        "slab_secret_list",
			Description: "List the NAMES of an app's secrets. Values are never returned.",
			InputSchema: obj(map[string]any{"name": str("App name")}, "name"),
			Annotations: readOnly(),
			handler: func(args map[string]any) (any, error) {
				out, _, err := call("GET", "/v1/apps/"+str2(args, "name")+"/secrets", nil)
				if err != nil {
					return nil, err
				}
				return out, nil
			},
		},
		{
			Name:        "slab_status",
			Description: "Daemon health: node name, app count, ingress proxy port. Use to confirm slab is up and which node you are talking to.",
			InputSchema: obj(map[string]any{}),
			Annotations: readOnly(),
			handler: func(args map[string]any) (any, error) {
				out, _, err := call("GET", "/v1/health", nil)
				return out, err
			},
		},
		{
			Name:        "slab_url",
			Description: "The local URL an app is served at (host-header routed through the slab ingress). For a public https URL use slab_expose.",
			InputSchema: obj(map[string]any{"name": str("App name")}, "name"),
			Annotations: readOnly(),
			handler: func(args map[string]any) (any, error) {
				health, _, err := call("GET", "/v1/health", nil)
				if err != nil {
					return nil, err
				}
				if _, _, err := call("GET", "/v1/apps/"+str2(args, "name"), nil); err != nil {
					return nil, err
				}
				return fmt.Sprintf("http://%s.localhost:%v", str2(args, "name"), health["proxyPort"]), nil
			},
		},
		{
			Name:        "slab_expose",
			Description: "Open a free public https URL for an app (Cloudflare quick tunnel — no account, no domain). The URL rotates each time a tunnel opens; do not hardcode it.",
			InputSchema: obj(map[string]any{"name": str("App name")}, "name"),
			handler:     appAction("expose"),
		},
		{
			Name:        "slab_hide",
			Description: "Close an app's public tunnel so it is reachable only locally again.",
			InputSchema: obj(map[string]any{"name": str("App name")}, "name"),
			Annotations: map[string]any{"idempotentHint": true},
			handler:     appAction("hide"),
		},
		{
			Name:        "slab_run",
			Description: "Run a job to completion in an isolated container and return its exit code and logs. Two modes: (1) sourceDir/gitUrl with a Dockerfile — the image is built and the command runs inside it; (2) image — a stock image (e.g. node:20) is pulled and the source directory is mounted read-write at /workspace. Use for tests, builds, scripts, one-off tasks. Blocks until the job finishes (or `wait` seconds elapse — the job keeps running; poll slab_jobs).",
			InputSchema: obj(map[string]any{
				"sourceDir": str("Absolute path to the source directory"),
				"gitUrl":    str("Git repository URL to clone and run"),
				"image":     str("Stock image to run instead of building a Dockerfile; source is mounted at /workspace"),
				"command":   strArr("Command to run, e.g. [\"npm\",\"test\"]; omit for the image default CMD"),
				"env":       strMap("Env vars for the job"),
				"timeout":   str("Kill the job after this long, e.g. \"90s\", \"10m\" (default 30m)"),
				"name":      str("Job name (default: source dir basename)"),
				"systems":   strArr("System networks to join — the job can reach members (including private ones) by name. This is the sandbox for working ON a system."),
				"wait":      map[string]any{"type": "integer", "description": "Max seconds to block for the result (default 300)"},
			}),
			handler: func(args map[string]any) (any, error) {
				body := map[string]any{}
				for _, k := range []string{"sourceDir", "gitUrl", "image", "command", "env", "timeout", "name", "systems"} {
					if v, ok := args[k]; ok {
						body[k] = v
					}
				}
				out, _, err := call("POST", "/v1/jobs", body)
				if err != nil {
					return nil, err
				}
				job := out["job"].(map[string]any)
				id := job["id"].(string)
				wait := 300.0
				if v, ok := args["wait"].(float64); ok && v > 0 {
					wait = v
				}
				deadline := time.Now().Add(time.Duration(wait) * time.Second)
				terminal := map[string]bool{"succeeded": true, "failed": true, "cancelled": true, "canceled": true}
				for !terminal[fmt.Sprint(job["state"])] && time.Now().Before(deadline) {
					time.Sleep(1500 * time.Millisecond)
					out, _, err = call("GET", "/v1/jobs/"+id, nil)
					if err != nil {
						return nil, err
					}
					job = out["job"].(map[string]any)
				}
				if !terminal[fmt.Sprint(job["state"])] {
					return map[string]any{"id": id, "state": job["state"], "note": "still running — check again with slab_jobs"}, nil
				}
				_, logs, _ := call("GET", "/v1/jobs/"+id+"/logs", nil)
				return map[string]any{"id": id, "state": job["state"], "exitCode": job["exitCode"], "error": job["error"], "logs": logs}, nil
			},
		},
		{
			Name:        "slab_jobs",
			Description: "List jobs (run-to-completion workloads started via slab_run or `slab run`), newest first: state, exit code, command, timings.",
			InputSchema: obj(map[string]any{}),
			Annotations: readOnly(),
			handler: func(args map[string]any) (any, error) {
				out, _, err := call("GET", "/v1/jobs", nil)
				if err != nil {
					return nil, err
				}
				return out["jobs"], nil
			},
		},
		{
			Name:        "slab_system_deploy",
			Description: "Deploy a system (a group of apps wired together on a private network) from a system.toml file: registers it, creates missing member apps, deploys every member, and starts trunks when members are placed on other nodes.",
			InputSchema: obj(map[string]any{
				"sourceFile": str("Absolute path to a system.toml"),
			}, "sourceFile"),
			handler: func(args map[string]any) (any, error) {
				out, _, err := call("POST", "/v1/systems", map[string]any{"sourceFile": str2(args, "sourceFile")})
				if err != nil {
					return nil, err
				}
				name := out["system"].(map[string]any)["name"].(string)
				out, _, err = call("POST", "/v1/systems/"+name+"/deploy", nil)
				if err != nil {
					return nil, err
				}
				return out["system"], nil
			},
		},
		{
			Name:        "slab_system_list",
			Description: "List systems (app groups with private networks and wiring): members, wire count, last deploy.",
			InputSchema: obj(map[string]any{}),
			Annotations: readOnly(),
			handler: func(args map[string]any) (any, error) {
				out, _, err := call("GET", "/v1/systems", nil)
				if err != nil {
					return nil, err
				}
				return out["systems"], nil
			},
		},
	}
	return ts
}

func appAction(action string) func(map[string]any) (any, error) {
	return func(args map[string]any) (any, error) {
		out, _, err := call("POST", "/v1/apps/"+str2(args, "name")+"/"+action, nil)
		if err != nil {
			return nil, err
		}
		return out["app"], nil
	}
}

func alreadyExists(err error) string {
	if !strings.Contains(err.Error(), "exists") {
		return ""
	}
	if i := strings.Index(err.Error(), `"`); i >= 0 {
		rest := err.Error()[i+1:]
		if j := strings.Index(rest, `"`); j >= 0 {
			return rest[:j]
		}
	}
	return ""
}

// ── stdio JSON-RPC loop ─────────────────────────────────────────────────────

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

func reply(w io.Writer, id json.RawMessage, result any) {
	msg, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
	fmt.Fprintf(w, "%s\n", msg)
}

func replyErr(w io.Writer, id json.RawMessage, code int, message string) {
	msg, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": code, "message": message}})
	fmt.Fprintf(w, "%s\n", msg)
}

// Run serves MCP over stdio until stdin closes.
func Run(version string) error {
	registry := map[string]*tool{}
	list := tools()
	for _, t := range list {
		registry[t.Name] = t
	}

	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 1024*1024), 16*1024*1024)
	out := os.Stdout

	for in.Scan() {
		line := strings.TrimSpace(in.Text())
		if line == "" {
			continue
		}
		var req rpcRequest
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			continue
		}
		if req.ID == nil { // notification — nothing to answer
			continue
		}
		switch req.Method {
		case "initialize":
			var p struct {
				ProtocolVersion string `json:"protocolVersion"`
			}
			_ = json.Unmarshal(req.Params, &p)
			pv := p.ProtocolVersion
			if pv == "" {
				pv = "2024-11-05"
			}
			reply(out, req.ID, map[string]any{
				"protocolVersion": pv,
				"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
				"serverInfo":      map[string]any{"name": "slab", "version": version},
			})
		case "ping":
			reply(out, req.ID, map[string]any{})
		case "tools/list":
			reply(out, req.ID, map[string]any{"tools": list})
		case "tools/call":
			var p struct {
				Name      string         `json:"name"`
				Arguments map[string]any `json:"arguments"`
			}
			_ = json.Unmarshal(req.Params, &p)
			t := registry[p.Name]
			if t == nil {
				replyErr(out, req.ID, -32602, "unknown tool "+p.Name)
				continue
			}
			result, err := t.handler(p.Arguments)
			if err != nil { // tool failures are results, not protocol errors
				reply(out, req.ID, map[string]any{
					"content": []map[string]any{{"type": "text", "text": err.Error()}},
					"isError": true,
				})
				continue
			}
			var text string
			if s, ok := result.(string); ok {
				text = s
			} else {
				pretty, _ := json.MarshalIndent(result, "", "  ")
				text = string(pretty)
			}
			reply(out, req.ID, map[string]any{
				"content": []map[string]any{{"type": "text", "text": text}},
			})
		default:
			replyErr(out, req.ID, -32601, "method not found: "+req.Method)
		}
	}
	return in.Err()
}
