package manifest

import (
	"fmt"
	"os"

	"github.com/BurntSushi/toml"
)

// SystemManifest mirrors the TS SystemManifest: name, members (source +
// optional node placement), wires ("app.ENV" -> value).
type SystemManifest struct {
	Name    string
	Members map[string]SystemMember
	Wires   map[string]string
}

type SystemMember struct {
	Source string
	Node   string
}

type rawSystem struct {
	Name  string                    `toml:"name"`
	Apps  map[string]rawSysMember   `toml:"apps"`
	Wires map[string]toml.Primitive `toml:"wires"`
}

type rawSysMember struct {
	Source string `toml:"source"`
	Node   string `toml:"node"`
}

// LoadSystem reads and validates a system.toml.
func LoadSystem(file string) (*SystemManifest, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, fmt.Errorf("No system manifest at %s", file)
	}
	var r rawSystem
	md, err := toml.Decode(string(data), &r)
	if err != nil {
		return nil, fmt.Errorf("invalid system.toml: %w", err)
	}

	if !nameRe.MatchString(r.Name) {
		return nil, fmt.Errorf("invalid system name %q — lowercase letters, digits, hyphens, 2-31 chars", r.Name)
	}
	members := map[string]SystemMember{}
	for app, cfg := range r.Apps {
		if !nameRe.MatchString(app) {
			return nil, fmt.Errorf("invalid member app name %q", app)
		}
		if cfg.Source == "" {
			return nil, fmt.Errorf("member %q is missing source", app)
		}
		if cfg.Node != "" && !nameRe.MatchString(cfg.Node) {
			return nil, fmt.Errorf("member %q has invalid node %q", app, cfg.Node)
		}
		members[app] = SystemMember{Source: cfg.Source, Node: cfg.Node}
	}
	if len(members) == 0 {
		return nil, fmt.Errorf("System has no [apps.<name>] members")
	}

	// TOML nuance (same as the TS parser): quoted "app.KEY" = v is a flat
	// dotted key; unquoted app.KEY = v is a nested table. Accept both.
	wires := map[string]string{}
	for key, prim := range r.Wires {
		var flat string
		if err := md.PrimitiveDecode(prim, &flat); err == nil {
			wires[key] = flat
			continue
		}
		var nested map[string]string
		if err := md.PrimitiveDecode(prim, &nested); err == nil {
			for sub, v := range nested {
				wires[key+"."+sub] = v
			}
			continue
		}
		return nil, fmt.Errorf("invalid wire %q — values must be strings", key)
	}

	return &SystemManifest{Name: r.Name, Members: members, Wires: wires}, nil
}
