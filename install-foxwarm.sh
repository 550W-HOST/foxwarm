#!/usr/bin/env bash
set -euo pipefail

FOXWARM_REPO="${FOXWARM_REPO:-https://github.com/550W-HOST/foxwarm.git}"
CALL_DIR="$PWD"
SCRIPT_ARGS=("$@")
for ((i=0; i<${#SCRIPT_ARGS[@]}; i++)); do
  case "${SCRIPT_ARGS[$i]}" in
    --data-dir)
      i=$((i + 1))
      [ "$i" -lt "${#SCRIPT_ARGS[@]}" ] || { echo "--data-dir requires a value" >&2; exit 2; }
      FOXWARM_DATA_DIR="${SCRIPT_ARGS[$i]}"
      ;;
    --data-dir=*)
      FOXWARM_DATA_DIR="${SCRIPT_ARGS[$i]#--data-dir=}"
      ;;
    --dir)
      i=$((i + 1))
      [ "$i" -lt "${#SCRIPT_ARGS[@]}" ] || { echo "--dir requires a value" >&2; exit 2; }
      FOXWARM_DIR="${SCRIPT_ARGS[$i]}"
      ;;
    --dir=*)
      FOXWARM_DIR="${SCRIPT_ARGS[$i]#--dir=}"
      ;;
    --help|-h)
      cat <<'EOF'
Usage: install-foxwarm.sh [--dir PATH] [--data-dir PATH]

Environment overrides:
  FOXWARM_REPO          Git repository URL
  FOXWARM_BRANCH        Branch to clone/update (default: main for new installs)
  FOXWARM_DIR           Program checkout directory (default: ./foxwarm)
  FOXWARM_DATA_DIR      Data/config directory (default: ./foxwarm-data)
  FOXWARM_TMUX_SESSION  tmux session name (default: foxwarm)
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: ${SCRIPT_ARGS[$i]}" >&2
      exit 2
      ;;
  esac
done

absolute_path_from_call_dir() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    ~) printf '%s\n' "$HOME" ;;
    ~/*) printf '%s/%s\n' "$HOME" "${1#~/}" ;;
    *) printf '%s/%s\n' "$CALL_DIR" "$1" ;;
  esac
}

if [ -z "${FOXWARM_DIR:-}" ] && [ -f "package.json" ] && grep -q '"name": "foxwarm"' package.json 2>/dev/null; then
  FOXWARM_DIR="$PWD"
else
  FOXWARM_DIR="${FOXWARM_DIR:-$PWD/foxwarm}"
fi
FOXWARM_DATA_DIR="${FOXWARM_DATA_DIR:-$(dirname "$FOXWARM_DIR")/foxwarm-data}"
FOXWARM_DIR="$(absolute_path_from_call_dir "$FOXWARM_DIR")"
FOXWARM_DATA_DIR="$(absolute_path_from_call_dir "$FOXWARM_DATA_DIR")"
if [ -z "${FOXWARM_BRANCH:-}" ] && [ -e "$FOXWARM_DIR/.git" ]; then
  FOXWARM_BRANCH="$(git -C "$FOXWARM_DIR" branch --show-current 2>/dev/null || true)"
fi
FOXWARM_BRANCH="${FOXWARM_BRANCH:-main}"
FOXWARM_TMUX_SESSION="${FOXWARM_TMUX_SESSION:-foxwarm}"

log() { printf '\033[1;34m[foxwarm-install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[foxwarm-install]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[foxwarm-install]\033[0m %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

ensure_basic_deps() {
  have git || fail "git is required. Please install git and rerun this script."
  have node || fail "Node.js 20.19+ (20.x) or 22.12+ is required. Install it from https://nodejs.org/ or your system package manager."
  have npm || fail "npm is required. Install Node.js 20.19+ (20.x) or 22.12+ with npm from https://nodejs.org/ or your system package manager."
  node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit((major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22 ? 0 : 1)' || fail "Node.js 20.19+ (20.x) or 22.12+ is required; found $(node -v 2>/dev/null || echo unknown). Please upgrade Node.js."
  have dotnet || fail ".NET 10 SDK (or a later SDK supporting net10.0) and the ASP.NET Core 10 runtime are required. Install them, then rerun this script."
  local sdk
  sdk="$(dotnet --version 2>/dev/null)" || fail "Cannot select a .NET SDK. Install a net10.0-capable SDK."
  [ "${sdk%%.*}" -ge 10 ] 2>/dev/null || fail "A net10.0-capable .NET SDK is required; selected $sdk."
  dotnet --list-runtimes | grep -q '^Microsoft.AspNetCore.App 10\.' || fail "The ASP.NET Core 10 runtime is required to run managed Main."
  have tmux || fail "tmux is required for Foxwarm's normal install start mode. Install tmux with your system package manager, then rerun this script."
}

ensure_source_build_deps() {
  # Root npm dependencies still include node-pty; Linux builds it via node-gyp.
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64)
      have python3 || fail "Python 3 is required for node-gyp and fresh pinned Monty acquisition."
      have make || fail "make is required to build the retained node-pty npm dependency."
      have g++ || fail "G++ is required to build the retained node-pty npm dependency."
      have gcc || fail "GCC and libc/libutil development files are required to build the Linux PTY helper."
      local probe
      probe="$(mktemp -d)"
      if ! printf '#include <pty.h>\nint main(void) { int m, s; return openpty(&m, &s, 0, 0, 0); }\n' | gcc -x c - -lutil -o "$probe/pty"; then
        rm -rf "$probe"
        fail "The Linux PTY helper needs GCC, pty.h and libutil development files. Install your distribution's C build prerequisites."
      fi
      rm -rf "$probe"
      ;;
    *) fail "This managed Main source candidate supports Linux x64 and Windows x64. macOS Main is not qualified; other-platform TypeScript Node clients are unchanged." ;;
  esac
}

checkout_repo() {
  if [ -e "$FOXWARM_DIR/.git" ]; then
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
  mkdir -p "$FOXWARM_DATA_DIR/state" "$FOXWARM_DATA_DIR/agents"
  FOXWARM_DATA_DIR="$(cd "$FOXWARM_DATA_DIR" && pwd -P)"
  printf '%s\n' "$FOXWARM_DATA_DIR" > "$FOXWARM_DIR/data_dir"
  export FOXWARM_DATA_DIR

  if tmux has-session -t "$FOXWARM_TMUX_SESSION" 2>/dev/null; then
    log "tmux session '$FOXWARM_TMUX_SESSION' already exists; sending restart command."
    npm run restart
  else
    log "Starting Foxwarm in tmux session '$FOXWARM_TMUX_SESSION'."
    npm start
  fi
}

wait_for_token() {
  local token_file="$FOXWARM_DATA_DIR/state/token"
  local i
  for i in $(seq 1 240); do
    if [ -s "$token_file" ]; then
      cat "$token_file"
      return 0
    fi
    if [ $((i % 20)) -eq 0 ]; then
      warn "Still waiting for token. You can inspect startup with: tmux attach -t '$FOXWARM_TMUX_SESSION'"
    fi
    sleep 0.5
  done
  return 1
}

get_http_port() {
  local config_file="$FOXWARM_DATA_DIR/state/config.yaml"
  if [ -f "$config_file" ]; then
    node -e "const fs=require('fs'); const yaml=require('js-yaml'); const cfg=yaml.load(fs.readFileSync(process.argv[1],'utf8'))||{}; console.log(cfg?.bot?.httpPort || 3001)" "$config_file" 2>/dev/null || echo 3001
  else
    echo 3001
  fi
}

print_next_steps() {
  local token=""
  local http_port=""
  token="$(wait_for_token || true)"
  http_port="$(get_http_port)"
  echo
  log "Foxwarm is starting in tmux."
  echo "Program dir: $FOXWARM_DIR"
  echo "Data dir:    $FOXWARM_DATA_DIR"
  if [ -n "$token" ]; then
    echo "WebUI: http://localhost:${http_port}/#token=${token}"
  else
    warn "Token file was not ready yet. When startup finishes, read it with: cat '$FOXWARM_DATA_DIR/state/token'"
    echo "WebUI: http://localhost:${http_port}/"
  fi
  echo
  echo "View logs / console: FOXWARM_TMUX_SESSION='$FOXWARM_TMUX_SESSION' tmux attach -t '$FOXWARM_TMUX_SESSION'"
  echo "Detach from tmux without stopping Foxwarm: Ctrl-b then d"
  echo "Stop later: cd '$FOXWARM_DIR' && FOXWARM_TMUX_SESSION='$FOXWARM_TMUX_SESSION' npm run stop"
  echo "Kill tmux session if needed: tmux kill-session -t '$FOXWARM_TMUX_SESSION'"
  echo
}

main() {
  ensure_basic_deps
  checkout_repo
  ensure_source_build_deps
  start_foxwarm
  print_next_steps
}

main "$@"
