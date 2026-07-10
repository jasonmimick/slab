package manifest

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestLoadFull(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "slab.toml", `
name = "conf-full"
type = "function"
port = 8080
public = false
image = "nginx:alpine"
postgres = true
secrets = ["API_KEY"]
volumes = ["pgdata:/var/lib/postgresql/data"]
idle_timeout = "3m"

[env]
GREETING = "hi"
`)
	m, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if m.Name != "conf-full" || m.Type != Function || m.Port != 8080 || m.Public ||
		m.Image != "nginx:alpine" || !m.Postgres || m.IdleTimeout != "3m" ||
		m.Secrets[0] != "API_KEY" || m.Volumes[0] != "pgdata:/var/lib/postgresql/data" ||
		m.Env["GREETING"] != "hi" {
		t.Fatalf("bad manifest: %+v", m)
	}
}

func TestDefaults(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "slab.toml", "name = \"conf-min\"\nport = 80\nimage = \"nginx:alpine\"\n")
	m, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if m.Type != Service || !m.Public || m.IdleTimeout != "5m" ||
		m.Env == nil || m.Secrets == nil || m.Volumes == nil {
		t.Fatalf("defaults wrong: %+v", m)
	}
}

func TestRejects(t *testing.T) {
	cases := []struct{ name, toml, wantErr string }{
		{"bad name", "name = \"X\"\nport = 80\nimage = \"i\"", "invalid app name"},
		{"bad port", "name = \"ok-app\"\nport = 0\nimage = \"i\"", "invalid port"},
		{"no image no dockerfile", "name = \"ok-app\"\nport = 80", "neither"},
		{"host path volume", "name = \"ok-app\"\nport = 80\nimage = \"i\"\nvolumes = [\"/host:/data\"]", "invalid volume"},
		{"relative volume target", "name = \"ok-app\"\nport = 80\nimage = \"i\"\nvolumes = [\"data:relative\"]", "invalid volume"},
		{"no colon volume", "name = \"ok-app\"\nport = 80\nimage = \"i\"\nvolumes = [\"bad volume entry\"]", "invalid volume"},
	}
	for _, c := range cases {
		dir := t.TempDir()
		write(t, dir, "slab.toml", c.toml)
		_, err := Load(dir)
		if err == nil || !strings.Contains(err.Error(), c.wantErr) {
			t.Errorf("%s: want error containing %q, got %v", c.name, c.wantErr, err)
		}
	}
}

func TestInferFromDockerfile(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "My_Cool Repo")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	write(t, dir, "Dockerfile", "FROM nginx:alpine\nEXPOSE 8081\n")
	m, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if m.Name != "my-cool-repo" || m.Port != 8081 || m.Type != Service || m.Env["PORT"] != "8081" {
		t.Fatalf("inference wrong: %+v", m)
	}
}

func TestInferNoDockerfile(t *testing.T) {
	if _, err := Load(t.TempDir()); err == nil || !strings.Contains(err.Error(), "no slab.toml") {
		t.Fatalf("want no-slab.toml error, got %v", err)
	}
}
