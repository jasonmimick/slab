#!/usr/bin/env bash
# slab installer — the localhost hyperscaler
#
#   curl -fsSL https://runslab.run/install | bash
#
# What it does: checks prerequisites (docker, git), downloads the slab binary
# for your platform from the latest GitHub release, puts `slab` on your PATH,
# clones the examples catalog to ~/.slab/src, and starts the daemon.
# Re-running upgrades in place (so does `slab upgrade`).
#
# Overrides: SLAB_VERSION (release tag, default latest), SLAB_HOME (default
# ~/.slab), SLAB_BIN_DIR (default /usr/local/bin, else ~/.local/bin),
# SLAB_REPO (git url for the examples catalog), SLAB_NO_START=1
set -euo pipefail

REPO="${SLAB_REPO:-https://github.com/runslab/slab.git}"
RELEASES="https://github.com/runslab/slab/releases"
SLAB_HOME="${SLAB_HOME:-$HOME/.slab}"
SRC="$SLAB_HOME/src"

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; AMB=$'\033[33m'; RST=$'\033[0m'
say()  { printf '%s\n' "${1-}"; }
ok()   { say "  ${GRN}✓${RST} $1"; }
warn() { say "  ${AMB}!${RST} $1"; }
die()  {
  say ""; say "  ${RED}✗ $1${RST}"
  if [ -n "${2-}" ]; then say "    ${DIM}fix:${RST} $2"; fi
  say ""; exit 1
}

say ""
say "${BOLD}  slab${RST} ${DIM}— the localhost hyperscaler${RST}"
say ""

# ── platform ──────────────────────────────────────────────────────────────────
case "$(uname -s)" in
  Darwin) OS="darwin" ;;
  Linux)  OS="linux" ;;
  *) die "unsupported OS: $(uname -s)" "slab runs on macOS and Linux (on Windows, use WSL2)" ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64)  ARCH="amd64" ;;
  *) die "unsupported architecture: $(uname -m)" "slab ships darwin/linux for arm64 and amd64" ;;
esac

# ── prerequisites ─────────────────────────────────────────────────────────────
HAVE_BREW=""
if command -v brew >/dev/null 2>&1; then HAVE_BREW=1; fi

command -v docker >/dev/null 2>&1 \
  || die "docker is not installed" \
         "$(if [ "$OS" = darwin ]; then echo 'https://docker.com/products/docker-desktop (or: brew install --cask docker)'; else echo 'curl -fsSL https://get.docker.com | sh'; fi)"
if docker info >/dev/null 2>&1; then
  ok "docker $(docker info --format '{{.ServerVersion}}' 2>/dev/null || echo '(engine up)')"
else
  die "docker is installed but the engine isn't running" \
      "$(if [ "$OS" = darwin ]; then echo 'start Docker Desktop, then re-run this installer'; else echo 'sudo systemctl start docker'; fi)"
fi

command -v git >/dev/null 2>&1 \
  || die "git is not installed (slab clones the repos you deploy)" \
         "$([ -n "$HAVE_BREW" ] && echo 'brew install git' || echo 'https://git-scm.com/downloads')"
ok "git $(git --version | awk '{print $3}')"

if command -v cloudflared >/dev/null 2>&1; then
  ok "cloudflared (public tunnels via slab expose)"
else
  warn "cloudflared not found — optional; only needed for ${BOLD}slab expose${RST} ${DIM}($([ -n "$HAVE_BREW" ] && echo 'brew install cloudflared' || echo 'https://github.com/cloudflare/cloudflared'))${RST}"
fi

# ── download the binary ───────────────────────────────────────────────────────
say ""
TARBALL="slab_${OS}_${ARCH}.tar.gz"
if [ -n "${SLAB_VERSION-}" ]; then
  URL="$RELEASES/download/$SLAB_VERSION/$TARBALL"
  SUMS_URL="$RELEASES/download/$SLAB_VERSION/sha256sums.txt"
  say "  ${DIM}downloading slab $SLAB_VERSION ($OS/$ARCH)…${RST}"
else
  URL="$RELEASES/latest/download/$TARBALL"
  SUMS_URL="$RELEASES/latest/download/sha256sums.txt"
  say "  ${DIM}downloading slab latest ($OS/$ARCH)…${RST}"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/$TARBALL" "$URL" \
  || die "download failed: $URL" "check $RELEASES for available versions/platforms"

if command -v shasum >/dev/null 2>&1 || command -v sha256sum >/dev/null 2>&1; then
  curl -fsSL -o "$TMP/sha256sums.txt" "$SUMS_URL" 2>/dev/null && {
    EXPECTED="$(awk -v f="$TARBALL" '$2==f{print $1}' "$TMP/sha256sums.txt")"
    if command -v sha256sum >/dev/null 2>&1; then
      ACTUAL="$(sha256sum "$TMP/$TARBALL" | awk '{print $1}')"
    else
      ACTUAL="$(shasum -a 256 "$TMP/$TARBALL" | awk '{print $1}')"
    fi
    [ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] \
      || die "checksum mismatch for $TARBALL" "re-run the installer; if it persists, open an issue"
    ok "checksum verified"
  } || warn "could not fetch checksums — skipping verification"
fi

tar -xzf "$TMP/$TARBALL" -C "$TMP" || die "could not unpack $TARBALL"

# ── put `slab` on PATH ────────────────────────────────────────────────────────
BIN_DIR="${SLAB_BIN_DIR:-/usr/local/bin}"
mkdir -p "$BIN_DIR" 2>/dev/null || true
[ -w "$BIN_DIR" ] || { BIN_DIR="$HOME/.local/bin"; mkdir -p "$BIN_DIR"; }
install -m 0755 "$TMP/slab" "$BIN_DIR/slab"
ok "slab -> $BIN_DIR/slab ${DIM}($("$BIN_DIR/slab" --version 2>/dev/null || echo 'installed'))${RST}"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on your PATH — add:  ${BOLD}export PATH=\"$BIN_DIR:\$PATH\"${RST}" ;;
esac

# ── examples catalog ──────────────────────────────────────────────────────────
mkdir -p "$SLAB_HOME"
if [ -d "$SRC/.git" ]; then
  git -C "$SRC" pull --ff-only --quiet 2>/dev/null \
    && ok "examples catalog updated ${DIM}($SRC)${RST}" \
    || warn "could not update $SRC — fine, the binary doesn't need it"
else
  git clone --depth 1 --quiet "$REPO" "$SRC" 2>/dev/null \
    && ok "examples catalog -> $SRC ${DIM}(slab up ~/.slab/src/examples/observatory)${RST}" \
    || warn "could not clone the examples catalog — fine, the binary doesn't need it"
fi

# ── start the daemon ──────────────────────────────────────────────────────────
if [ -n "${SLAB_NO_START-}" ]; then
  warn "SLAB_NO_START set — start it yourself:  slab daemon"
elif curl -fsS -m 2 http://127.0.0.1:7766/v1/health >/dev/null 2>&1; then
  warn "a slab daemon is already running — pick up this version with:  ${BOLD}slab upgrade${RST}"
else
  say "  ${DIM}starting the daemon…${RST}"
  nohup "$BIN_DIR/slab" daemon > "$SLAB_HOME/daemon.log" 2>&1 &
  for _ in $(seq 1 40); do
    curl -fsS -m 1 http://127.0.0.1:7766/v1/health >/dev/null 2>&1 && break
    sleep 0.5
  done
  curl -fsS -m 2 http://127.0.0.1:7766/v1/health >/dev/null 2>&1 \
    || die "daemon did not come up" "see $SLAB_HOME/daemon.log"
  ok "daemon up — api :7766, ingress :8080 ${DIM}(log: $SLAB_HOME/daemon.log)${RST}"
fi

say ""
say "  ${BOLD}done.${RST} next moves:"
say ""
say "    ${BOLD}open http://localhost:7766${RST}        ${DIM}the rack${RST}"
say "    slab deploy owner/repo             ${DIM}any github repo with a Dockerfile${RST}"
say "    slab run . -- npm test             ${DIM}one-shot job in a container${RST}"
say "    slab list · slab jobs · slab status"
say ""
