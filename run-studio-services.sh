#!/bin/bash
# Manually start and stop Qwen Image Studio and its password-protected Cloudflare Named Tunnel.
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="${HOME:?HOME is not set}"
UID_NUM="$(id -u)"
DOMAIN="gui/$UID_NUM"
SERVICE_DIR="$HOME_DIR/Library/Application Support/Qwen Image Studio"
LOG_DIR="$HOME_DIR/Library/Logs/Qwen Image Studio"
AGENT_DIR="$HOME_DIR/Library/LaunchAgents"
PASSWORD_FILE="${TUNNEL_PASSWORD_FILE:-$SERVICE_DIR/tunnel-password}"
LEGACY_PASSWORD_FILE="/private/tmp/qis-tunnel-password"
TUNNEL_TOKEN_FILE="${CLOUDFLARE_TUNNEL_TOKEN_FILE:-$SERVICE_DIR/tunnel-token}"
TUNNEL_CONFIG_FILE="${CLOUDFLARED_CONFIG_FILE:-$HOME_DIR/.cloudflared/config.yml}"
HOSTNAME_FILE="$SERVICE_DIR/tunnel-hostname"
BASE_URL="http://127.0.0.1:3210"
PROXY_URL="http://127.0.0.1:3211"
COMFY_BASE_URL="${COMFY_URL:-http://127.0.0.1:8188}"

# --force 는 대기·생성 중 작업이 있어도 중지/재시작한다. 멈춘 서비스를 복구할 때만 쓴다.
FORCE=0

# next-server 는 시작 직후 프로세스 제목을 `next-server (vX.Y.Z)` 로 바꾼다.
# 따라서 `next/dist/bin/next` 경로로는 정지·상태 판별이 실패해 프로세스가 남는다.
WEB_MARKER='next-server'

WEB_LABEL="com.qwen-image-studio.web"
AUTH_LABEL="com.qwen-image-studio.auth"
TUNNEL_LABEL="com.qwen-image-studio.tunnel"
WEB_PLIST="$AGENT_DIR/$WEB_LABEL.plist"
AUTH_PLIST="$AGENT_DIR/$AUTH_LABEL.plist"
TUNNEL_PLIST="$AGENT_DIR/$TUNNEL_LABEL.plist"

WEB_PID_FILE="$SERVICE_DIR/web.pid"
AUTH_PID_FILE="$SERVICE_DIR/auth.pid"
TUNNEL_PID_FILE="$SERVICE_DIR/tunnel.pid"
COMFY_PID_FILE="$SERVICE_DIR/comfy.pid"
WEB_LOG="$LOG_DIR/web.log"
AUTH_LOG="$LOG_DIR/auth.log"
TUNNEL_LOG="$LOG_DIR/tunnel.log"
COMFY_LOG="$LOG_DIR/comfy.log"

usage() {
  cat <<'EOF'
Qwen Image Studio 수동 서비스 관리

  ./run-studio-services.sh [start|stop|restart|status|logs]
  ./run-studio-services.sh --force [start|stop|restart]

start (기본값)는 ComfyUI, 웹 앱과 암호 보호 프록시를 nohup으로 실행합니다.
Cloudflare Named Tunnel 설정 파일 또는 토큰 파일이 있으면 터널도 실행합니다.
자동 재시작은 하지 않습니다. 중지되면 이 스크립트의 start로 다시 실행하세요.

--force 를 붙이면 대기·생성 중 작업이 있어도 중지·재시작합니다. 서비스가 멈춰
복구가 필요할 때만 사용하세요. 작업 목록은 web/data/jobs.json 에 그대로 남습니다.
EOF
}

fail() { printf '오류: %s\n' "$*" >&2; exit 1; }
has_command() { command -v "$1" >/dev/null 2>&1; }
http_code() { curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "$1" 2>/dev/null || true; }

prepare_paths() {
  mkdir -p "$SERVICE_DIR" "$LOG_DIR" "$AGENT_DIR"
  chmod 700 "$SERVICE_DIR" "$LOG_DIR" "$AGENT_DIR"
  touch "$WEB_LOG" "$AUTH_LOG" "$TUNNEL_LOG" "$COMFY_LOG"
  chmod 600 "$WEB_LOG" "$AUTH_LOG" "$TUNNEL_LOG" "$COMFY_LOG"
}

prepare_password() {
  if [[ ! -s "$PASSWORD_FILE" ]]; then
    if [[ -s "$LEGACY_PASSWORD_FILE" ]]; then
      install -m 600 "$LEGACY_PASSWORD_FILE" "$PASSWORD_FILE"
    elif [[ -n "${TUNNEL_PASSWORD:-}" ]]; then
      printf '%s' "$TUNNEL_PASSWORD" > "$PASSWORD_FILE"
      chmod 600 "$PASSWORD_FILE"
    elif [[ -t 0 ]]; then
      local entered_password
      read -r -s -p '사이트 접속 암호 입력: ' entered_password
      printf '\n'
      [[ -n "$entered_password" ]] || fail "암호를 입력해야 합니다."
      printf '%s' "$entered_password" > "$PASSWORD_FILE"
      chmod 600 "$PASSWORD_FILE"
      unset entered_password
    else
      fail "암호 파일이 없습니다: $PASSWORD_FILE"
    fi
  fi
  chmod 600 "$PASSWORD_FILE"
  [[ -s "$PASSWORD_FILE" ]] || fail "암호 파일이 비어 있습니다."
}

busy_job_count() {
  local jobs_json="$1"
  "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const x=JSON.parse(s);const jobs=Array.isArray(x)?x:(x.jobs||[]);console.log(jobs.filter(j=>j.status==="queued"||j.status==="running").length)}catch{process.exit(2)}})' <<< "$jobs_json"
}

ensure_idle() {
  local jobs_json busy_count
  if [[ "$FORCE" == "1" ]]; then
    printf '경고: --force 로 실행 중 작업 확인을 건너뜁니다. 작업 목록은 보존됩니다.\n' >&2
    return 0
  fi
  if jobs_json="$(curl -fsS --max-time 3 "$BASE_URL/api/jobs" 2>/dev/null)"; then
    busy_count="$(busy_job_count "$jobs_json")" || fail "작업 상태를 읽지 못해 중지를 취소했습니다."
  elif [[ -f "$ROOT_DIR/web/data/jobs.json" ]]; then
    jobs_json="$(cat "$ROOT_DIR/web/data/jobs.json")"
    busy_count="$(busy_job_count "$jobs_json")" || fail "저장된 작업 상태를 읽지 못해 중지를 취소했습니다."
  else
    busy_count=0
  fi
  [[ "$busy_count" == "0" ]] || fail "대기 또는 생성 중인 작업이 ${busy_count}개입니다. 완료 후 다시 실행하세요."
}

pid_matches() {
  local pid_file="$1" marker="$2" pid command_line
  [[ -s "$pid_file" ]] || return 1
  pid="$(cat "$pid_file")"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [[ "$command_line" == *"$marker"* ]]
}

listener_pids() {
  lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true
}

ensure_port_free() {
  local port="$1" listeners="$2"
  listeners="$(listener_pids "$port")"
  [[ -z "$listeners" ]] || fail "포트 $port를 다른 프로세스가 사용 중입니다 (PID $listeners)."
}

agent_is_ours() {
  local label="$1" plist_path="$2" details
  details="$(launchctl print "$DOMAIN/$label" 2>/dev/null || true)"
  [[ "$details" == *"path = $plist_path"* ]]
}

remove_legacy_agents() {
  local label plist_path
  for label in "$TUNNEL_LABEL" "$AUTH_LABEL" "$WEB_LABEL"; do
    case "$label" in
      "$WEB_LABEL") plist_path="$WEB_PLIST" ;;
      "$AUTH_LABEL") plist_path="$AUTH_PLIST" ;;
      *) plist_path="$TUNNEL_PLIST" ;;
    esac
    if launchctl print "$DOMAIN/$label" >/dev/null 2>&1; then
      agent_is_ours "$label" "$plist_path" || fail "같은 이름의 다른 LaunchAgent를 발견했습니다: $label"
      launchctl bootout "$DOMAIN/$label" || fail "기존 LaunchAgent를 중지하지 못했습니다: $label"
    fi
    [[ ! -e "$plist_path" ]] || rm -f "$plist_path"
  done
}

start_process() {
  local name="$1" pid_file="$2" marker="$3"
  shift 3
  nohup "$@" </dev/null >> "$LOG_DIR/$name.log" 2>&1 &
  printf '%s\n' "$!" > "$pid_file"
  chmod 600 "$pid_file"
}

start_comfy() {
  local attempt
  [[ "$COMFY_BASE_URL" == "http://127.0.0.1:8188" ]] || return 0
  if [[ "$(http_code "$COMFY_BASE_URL/system_stats")" == "200" ]]; then return 0; fi
  [[ -x "$ROOT_DIR/ComfyUI/.venv/bin/python" ]] || return 0
  ensure_port_free 8188 ""
  # ComfyUI 가 모델을 로딩하려면 파일 디스크립터가 충분해야 한다 (macOS 기본 256 은 부족).
  ulimit -n 65536 2>/dev/null || true
  start_process comfy "$COMFY_PID_FILE" 'main.py' "$ROOT_DIR/run-comfyui.sh" --lowvram
  for attempt in $(seq 1 90); do
    [[ "$(http_code "$COMFY_BASE_URL/system_stats")" == "200" ]] && return 0
    if (( attempt > 5 )) && ! pid_matches "$COMFY_PID_FILE" 'main.py'; then break; fi
    sleep 1
  done
  fail "ComfyUI가 시작되지 않았습니다. 로그: $COMFY_LOG"
}

start_web() {
  local next_cli="$ROOT_DIR/web/node_modules/next/dist/bin/next" attempt
  if [[ "$(http_code "$BASE_URL/api/status")" == "200" ]]; then return 0; fi
  ensure_port_free 3210 ""
  # 웹 앱도 업로드·SSE 연결이 몰리면 fd 가 부족하다 (macOS 기본 256).
  ulimit -n 65536 2>/dev/null || true
  (
    cd "$ROOT_DIR/web"
    COMFY_URL="${COMFY_URL:-http://127.0.0.1:8188}" COMFY_AUTOSTART="${COMFY_AUTOSTART:-0}" start_process web "$WEB_PID_FILE" "$next_cli" "$NODE_BIN" "$next_cli" start --port 3210
  )
  for attempt in $(seq 1 45); do
    [[ "$(http_code "$BASE_URL/api/status")" == "200" ]] && return 0
    sleep 1
  done
  fail "웹 앱이 시작되지 않았습니다. 로그: $WEB_LOG"
}

start_auth() {
  local proxy_script="$ROOT_DIR/scripts/tunnel-auth-proxy.js" attempt
  if [[ "$(http_code "$PROXY_URL/")" == "401" ]]; then return 0; fi
  ensure_port_free 3211 ""
  TUNNEL_PASSWORD_FILE="$PASSWORD_FILE" COMFY_URL="${COMFY_URL:-http://127.0.0.1:8188}" COMFY_AUTOSTART="${COMFY_AUTOSTART:-0}" nohup "$NODE_BIN" "$proxy_script" </dev/null >> "$AUTH_LOG" 2>&1 &
  printf '%s\n' "$!" > "$AUTH_PID_FILE"
  chmod 600 "$AUTH_PID_FILE"
  for attempt in $(seq 1 30); do
    [[ "$(http_code "$PROXY_URL/")" == "401" ]] && return 0
    sleep 1
  done
  fail "인증 프록시가 시작되지 않았습니다. 로그: $AUTH_LOG"
}

start_tunnel() {
  local cloudflared_bin attempt hostname
  local -a tunnel_args
  if [[ -s "$TUNNEL_CONFIG_FILE" ]]; then
    tunnel_args=(tunnel --config "$TUNNEL_CONFIG_FILE" run)
  elif [[ -s "$TUNNEL_TOKEN_FILE" ]]; then
    tunnel_args=(tunnel run --token-file "$TUNNEL_TOKEN_FILE")
  else
    return 0
  fi
  if pid_matches "$TUNNEL_PID_FILE" 'cloudflared tunnel'; then return 0; fi
  cloudflared_bin="$(command -v cloudflared)"
  nohup "$cloudflared_bin" "${tunnel_args[@]}" </dev/null >> "$TUNNEL_LOG" 2>&1 &
  printf '%s\n' "$!" > "$TUNNEL_PID_FILE"
  chmod 600 "$TUNNEL_PID_FILE"
  for attempt in $(seq 1 45); do
    if [[ -s "$HOSTNAME_FILE" ]]; then
      hostname="$(tr -d '\r\n ' < "$HOSTNAME_FILE")"
      if [[ -n "$hostname" && "$(http_code "https://$hostname/")" == "401" ]]; then return 0; fi
    elif rg -q 'Registered tunnel connection' "$TUNNEL_LOG" 2>/dev/null; then
      return 0
    fi
    if ! pid_matches "$TUNNEL_PID_FILE" 'cloudflared tunnel'; then break; fi
    sleep 1
  done
  fail "Named Tunnel 연결을 확인하지 못했습니다. 로그: $TUNNEL_LOG"
}

start_services() {
  [[ "$(uname -s)" == "Darwin" ]] || fail "이 스크립트는 macOS용입니다."
  for command_name in curl lsof launchctl node cloudflared nohup; do
    has_command "$command_name" || fail "$command_name 을 찾을 수 없습니다."
  done
  NODE_BIN="$(node -p 'process.execPath')"
  [[ -x "$ROOT_DIR/web/node_modules/.bin/next" ]] || fail "웹 의존성이 없습니다. 먼저 (cd web && npm ci)를 실행하세요."
  [[ -f "$ROOT_DIR/web/.next/BUILD_ID" ]] || fail "프로덕션 빌드가 없습니다. 먼저 ./run-web.sh build를 실행하세요."
  [[ -f "$ROOT_DIR/scripts/tunnel-auth-proxy.js" ]] || fail "인증 프록시 파일이 없습니다."
  prepare_paths
  prepare_password
  if [[ "$(http_code "$BASE_URL/api/status")" == "200" ]] &&
    [[ "$(http_code "$PROXY_URL/")" == "401" ]] &&
    pid_matches "$WEB_PID_FILE" "$WEB_MARKER" &&
    pid_matches "$AUTH_PID_FILE" 'tunnel-auth-proxy.js'; then
    start_comfy
    start_tunnel
    status_services
    printf '이미 실행 중입니다.\n'
    return 0
  fi
  ensure_idle
  remove_legacy_agents
  start_comfy
  start_web
  start_auth
  start_tunnel

  printf 'ComfyUI: %s (HTTP %s)\n' "$COMFY_BASE_URL" "$(http_code "$COMFY_BASE_URL/system_stats")"
  printf '웹 앱: %s (HTTP %s)\n' "$BASE_URL" "$(http_code "$BASE_URL/api/status")"
  printf '인증 프록시: %s (HTTP %s, 암호 인증 대기)\n' "$PROXY_URL" "$(http_code "$PROXY_URL/")"
  if [[ -s "$TUNNEL_CONFIG_FILE" || -s "$TUNNEL_TOKEN_FILE" ]]; then
    if [[ -s "$HOSTNAME_FILE" ]]; then
      printf 'Cloudflare Named Tunnel: https://%s (HTTP 401은 암호 입력 전 정상 응답)\n' "$(tr -d '\r\n ' < "$HOSTNAME_FILE")"
    else
      printf 'Cloudflare Named Tunnel: 연결됨\n'
    fi
  else
    printf 'Cloudflare Named Tunnel: CLI 로그인 및 설정 대기 중\n'
  fi
  printf '로그: %s\n중지된 경우 다시 실행: ./run-studio-services.sh start\n' "$LOG_DIR"
}

stop_pid() {
  local pid_file="$1" marker="$2" pid attempt
  if pid_matches "$pid_file" "$marker"; then
    pid="$(cat "$pid_file")"
    kill -TERM "$pid" 2>/dev/null || true
    for attempt in $(seq 1 30); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.2
    done
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$pid_file"
}

# PID 파일이 없거나 낡아 stop_pid 가 놓친 리스너를 정리한다.
# 마커가 맞을 때만 끝내 다른 프로세스를 건드리지 않는다.
stop_stale_listener() {
  local port="$1" marker="$2" pid command_line
  for pid in $(listener_pids "$port"); do
    command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    [[ "$command_line" == *"$marker"* ]] || continue
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 30); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.2
    done
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
  done
}

stop_services() {
  NODE_BIN="$(command -v node >/dev/null 2>&1 && node -p 'process.execPath' || echo node)"
  ensure_idle
  remove_legacy_agents
  stop_pid "$TUNNEL_PID_FILE" 'cloudflared tunnel'
  stop_pid "$AUTH_PID_FILE" 'tunnel-auth-proxy.js'
  stop_pid "$WEB_PID_FILE" "$WEB_MARKER"
  stop_stale_listener 3210 "$WEB_MARKER"
  stop_pid "$COMFY_PID_FILE" 'main.py'
  printf 'ComfyUI, 웹 앱, 인증 프록시, Named Tunnel을 중지했습니다. 저장된 이미지와 암호는 유지했습니다.\n'
}

status_services() {
  local tunnel_state=stopped
  printf 'ComfyUI: HTTP %s\n' "$(http_code "$COMFY_BASE_URL/system_stats")"
  printf '웹 앱: HTTP %s\n' "$(http_code "$BASE_URL/api/status")"
  printf '인증 프록시: HTTP %s\n' "$(http_code "$PROXY_URL/")"
  if [[ -s "$TUNNEL_CONFIG_FILE" || -s "$TUNNEL_TOKEN_FILE" ]] && pid_matches "$TUNNEL_PID_FILE" 'cloudflared tunnel'; then tunnel_state=running; fi
  printf 'Cloudflare Named Tunnel: %s\n' "$tunnel_state"
  if [[ -s "$HOSTNAME_FILE" ]]; then printf '주소: https://%s\n' "$(tr -d '\r\n ' < "$HOSTNAME_FILE")"; fi
}

show_logs() {
  prepare_paths
  tail -F "$COMFY_LOG" "$WEB_LOG" "$AUTH_LOG" "$TUNNEL_LOG"
}

ACTION="${1:-start}"
if [[ "${1:-}" == "--force" ]]; then
  FORCE=1
  ACTION="${2:-start}"
fi
case "$ACTION" in
  start) start_services ;;
  stop) stop_services ;;
  restart) stop_services; start_services ;;
  status) status_services ;;
  logs) show_logs ;;
  -h|--help|help) usage ;;
  *) usage >&2; fail "알 수 없는 명령: $ACTION" ;;
esac
