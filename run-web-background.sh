#!/usr/bin/env zsh
# Qwen Image 2.1 Studio 웹 앱을 백그라운드에서 켜고 끈다.
#
# 사용법:
#   ./run-web-background.sh                 # 백그라운드로 시작 (빌드 결과가 없으면 먼저 빌드)
#   ./run-web-background.sh --status        # 실행 상태 확인
#   ./run-web-background.sh --stop          # 서버 정지
#   ./run-web-background.sh --stop --delete # 데이터(작업 기록·생성 이미지·참조 이미지)를 모두 지운 뒤 정지
#
# 로그는 web.log, PID 는 web/.web.pid 에 남는다.
#
# 환경변수:
#   PORT=3210             웹 앱 포트
#   COMFY_URL, COMFY_AUTOSTART, QWEN_ROOT   run-web.sh 와 같다
set -euo pipefail
cd "$(dirname "$0")"
export PORT="${PORT:-3210}"
PID_FILE="web/.web.pid"
LOG_FILE="web.log"
# node 탐색. 비대화형 셸(SSH 원격 실행, cron, launchd)에는 nvm·homebrew 경로가 PATH 에 없다.
# next 실행 파일은 `#!/usr/bin/env node` 셔뱅이라 PATH 에 node 가 없으면 그대로 실패한다.
# 그래서 PATH 를 먼저 보정하고, 그래도 없으면 흔한 설치 위치를 직접 찾는다.
ensure_node_on_path() {
  if command -v node >/dev/null 2>&1; then return 0; fi
  # nvm 을 쓴다면 사용자가 고른 기본 버전을 먼저 존중한다. 여러 개면 가장 높은 버전을 쓴다.
  local nvm_root="$HOME/.nvm/versions/node"
  local preferred="" picked="" candidate
  if [[ -r "$HOME/.nvm/alias/default" ]]; then
    preferred="$(<"$HOME/.nvm/alias/default")"
    preferred="${preferred#v}"
  fi
  if [[ -n "$preferred" && -x "$nvm_root/v$preferred/bin/node" ]]; then
    picked="$nvm_root/v$preferred/bin"
  elif [[ -d "$nvm_root" ]]; then
    picked="$(ls -d "$nvm_root"/*/bin 2>/dev/null | sort -V | tail -1)"
  fi
  for candidate in "$picked" /opt/homebrew/bin /usr/local/bin /usr/bin; do
    if [[ -n "$candidate" && -x "$candidate/node" ]]; then
      PATH="$candidate:$PATH"
      export PATH
      return 0
    fi
  done
  return 1
}

# node 실행 파일의 절대 경로. PATH 에 없으면 설치 위치를 찾아 돌려준다.
node_bin() {
  ensure_node_on_path || return 1
  node -p 'process.execPath'
}

BASE="http://127.0.0.1:${PORT}"

STOP=0; DELETE=0; STATUS=0
for arg in "$@"; do
  case "$arg" in
    --stop) STOP=1 ;;
    --delete) DELETE=1 ;;
    --status) STATUS=1 ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "알 수 없는 옵션: $arg (--stop | --delete | --status | --help)"; exit 1 ;;
  esac
done
if (( DELETE && !STOP )); then
  echo "--delete 는 --stop 과 함께 써야 합니다. 서버를 유지한 채 데이터만 지우려면 ./reset-data.sh 를 쓰세요."
  exit 1
fi

# 포트를 듣고 있는 PID (PID 파일이 없거나 틀려도 찾을 수 있게 포트 기준)
listening_pid() { lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true; }
alive() { [[ -n "$1" ]] && kill -0 "$1" 2>/dev/null; }

show_status() {
  local pid; pid=$(listening_pid)
  if [[ -n "$pid" ]]; then
    echo "실행 중: $BASE (PID $pid)"
    return 0
  fi
  echo "꺼져 있음 (포트 $PORT)"
  return 1
}

if (( STATUS )); then show_status; exit $?; fi

if (( STOP )); then
  PID=$(listening_pid)
  if [[ -z "$PID" ]] && [[ -f "$PID_FILE" ]]; then
    PID=$(cat "$PID_FILE"); alive "$PID" || PID=""
  fi

  if (( DELETE )); then
    echo "데이터를 모두 지웁니다..."
    ./reset-data.sh --yes   # 서버가 켜져 있으면 API 로, 꺼져 있으면 파일을 직접 지운다
  fi

  if [[ -z "$PID" ]]; then
    echo "서버가 실행 중이 아닙니다."
    rm -f "$PID_FILE"
    exit 0
  fi

  echo "서버를 정지합니다 (PID $PID)..."
  kill -TERM "$PID" 2>/dev/null || true
  for _ in $(seq 1 15); do alive "$PID" || break; sleep 1; done
  if alive "$PID"; then
    echo "정상 종료되지 않아 강제로 끝냅니다."
    kill -KILL "$PID" 2>/dev/null || true
    sleep 1
  fi
  # 같은 포트를 듣는 다른 프로세스(옛 npm 래퍼 등)가 남았으면 함께 정리한다
  LEFT=$(listening_pid)
  if [[ -n "$LEFT" ]]; then kill -KILL "$LEFT" 2>/dev/null || true; fi
  rm -f "$PID_FILE"
  echo "정지했습니다."
  exit 0
fi

# 시작
if show_status >/dev/null; then
  echo "이미 실행 중입니다: $BASE (PID $(listening_pid)). 재시작하려면 --stop 뒤에 다시 실행하세요."
  exit 0
fi
[[ -x web/node_modules/.bin/next ]] || { echo "web/node_modules 가 없습니다. 먼저 (cd web && npm install) 을 실행하세요."; exit 1; }
ensure_node_on_path || { echo "node 를 찾을 수 없습니다. nvm 이라면 ~/.nvm/versions/node/*/bin 을 확인하세요."; exit 1; }
if [[ ! -f web/.next/BUILD_ID ]]; then
  echo "빌드 결과가 없어 먼저 빌드합니다..."
  (cd web && ./node_modules/.bin/next build)
fi

: > "$LOG_FILE"
nohup ./run-web.sh >> "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
echo "시작 중... (로그: $LOG_FILE)"
for _ in $(seq 1 30); do
  if curl -sf -m 2 -o /dev/null "$BASE/api/status"; then
    echo "실행 중: $BASE (PID $(listening_pid))"
    exit 0
  fi
  alive "$(cat "$PID_FILE")" || { echo "서버가 바로 종료되었습니다. 로그를 확인하세요:"; tail -20 "$LOG_FILE"; rm -f "$PID_FILE"; exit 1; }
  sleep 1
done
echo "30초 안에 응답이 없습니다. 로그를 확인하세요: tail -f $LOG_FILE"
exit 1
