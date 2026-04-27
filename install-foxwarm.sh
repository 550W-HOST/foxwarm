#!/usr/bin/env bash
set -euo pipefail

FOXWARM_REPO="${FOXWARM_REPO:-https://github.com/550W-HOST/foxwarm.git}"
if [ -z "${FOXWARM_DIR:-}" ] && [ -f "package.json" ] && grep -q '"name": "foxwarm"' package.json 2>/dev/null; then
  FOXWARM_DIR="$PWD"
else
  FOXWARM_DIR="${FOXWARM_DIR:-$HOME/foxwarm}"
fi
if [ -z "${FOXWARM_BRANCH:-}" ] && [ -d "$FOXWARM_DIR/.git" ]; then
  FOXWARM_BRANCH="$(git -C "$FOXWARM_DIR" branch --show-current 2>/dev/null || true)"
fi
FOXWARM_BRANCH="${FOXWARM_BRANCH:-main}"
FOXWARM_TMUX_SESSION="${FOXWARM_TMUX_SESSION:-foxwarm}"
HTTP_PORT="${HTTP_PORT:-3001}"

log() { printf '\033[1;34m[foxwarm-install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[foxwarm-install]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[foxwarm-install]\033[0m %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

run_with_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif have sudo; then
    sudo "$@"
  else
    fail "Need sudo/root to install missing dependency: $*"
  fi
}

install_tmux() {
  if have tmux; then
    return
  fi

  warn "tmux is not installed; trying to install it automatically."
  if have apt-get; then
    run_with_sudo apt-get update
    run_with_sudo apt-get install -y tmux
  elif have pacman; then
    run_with_sudo pacman -Sy --noconfirm tmux
  elif have dnf; then
    run_with_sudo dnf install -y tmux
  elif have yum; then
    run_with_sudo yum install -y tmux
  elif have zypper; then
    run_with_sudo zypper --non-interactive install tmux
  elif have brew; then
    brew install tmux
  else
    fail "Could not find a supported package manager to install tmux. Please install tmux and rerun this script."
  fi

  have tmux || fail "tmux installation did not make tmux available on PATH."
}

ensure_basic_deps() {
  have git || fail "git is required. Please install git and rerun this script."
  have npm || fail "Node.js 20+ and npm are required. Please install Node.js 20+ and rerun this script."
  install_tmux
}

checkout_repo() {
  if [ -d "$FOXWARM_DIR/.git" ]; then
    log "Using existing checkout: $FOXWARM_DIR"
    git -C "$FOXWARM_DIR" fetch origin "$FOXWARM_BRANCH" || warn "Fetch failed; continuing with existing checkout."
    git -C "$FOXWARM_DIR" checkout "$FOXWARM_BRANCH" || git -C "$FOXWARM_DIR" checkout -B "$FOXWARM_BRANCH" "origin/$FOXWARM_BRANCH" || true
    git -C "$FOXWARM_DIR" pull --ff-only origin "$FOXWARM_BRANCH" || warn "Could not fast-forward existing checkout; leaving local files unchanged."
  else
    log "Cloning Foxwarm into $FOXWARM_DIR"
    mkdir -p "$(dirname "$FOXWARM_DIR")"
    git clone --branch "$FOXWARM_BRANCH" "$FOXWARM_REPO" "$FOXWARM_DIR"
  fi
}

start_foxwarm() {
  cd "$FOXWARM_DIR"
  mkdir -p state agents skills

  if tmux has-session -t "$FOXWARM_TMUX_SESSION" 2>/dev/null; then
    log "tmux session '$FOXWARM_TMUX_SESSION' already exists; sending restart command."
    npm run restart
  else
    log "Starting Foxwarm in tmux session '$FOXWARM_TMUX_SESSION'."
    npm start
  fi
}

wait_for_token() {
  local token_file="$FOXWARM_DIR/state/token"
  local i
  for i in $(seq 1 40); do
    if [ -s "$token_file" ]; then
      cat "$token_file"
      return 0
    fi
    sleep 0.5
  done
  return 1
}

print_next_steps() {
  local token=""
  token="$(wait_for_token || true)"
  echo
  log "Foxwarm is starting in tmux."
  if [ -n "$token" ]; then
    echo "WebUI: http://localhost:${HTTP_PORT}/#token=${token}"
  else
    warn "Token file was not ready yet. When startup finishes, read it with: cat '$FOXWARM_DIR/state/token'"
    echo "WebUI: http://localhost:${HTTP_PORT}/"
  fi
  echo
  echo "You are about to attach to the tmux session."
  echo "Detach without stopping Foxwarm: Ctrl-b then d"
  echo "Stop later: cd '$FOXWARM_DIR' && npm run stop"
  echo
}

main() {
  ensure_basic_deps
  checkout_repo
  start_foxwarm
  print_next_steps
  if [ -n "${TMUX:-}" ]; then
    tmux switch-client -t "$FOXWARM_TMUX_SESSION"
  else
    exec tmux attach -t "$FOXWARM_TMUX_SESSION"
  fi
}

main "$@"
