#!/usr/bin/env zsh
# Qwen Image 2.1 Studio 웹 앱 실행
#
# 사용법:
#   ./run-web.sh          # 프로덕션 모드. 빌드 결과가 없으면 먼저 빌드한다
#   ./run-web.sh dev      # 개발 모드 (코드 수정이 바로 반영)
#   ./run-web.sh build    # 빌드만 다시 한다
#
# 환경변수:
#   PORT=3210             웹 앱 포트
#   COMFY_URL=http://127.0.0.1:8188   ComfyUI 서버 주소
#   COMFY_AUTOSTART=1     ComfyUI 가 꺼져 있으면 자동으로 run-comfyui.sh 를 실행 (0 이면 끔)
set -euo pipefail
cd "$(dirname "$0")/web"
export PORT="${PORT:-3210}"
MODE="${1:-start}"

# macOS 기본 soft limit(256)은 파일 업로드와 SSE 연결이 몰릴 때 부족하다.
ulimit -n 65536 2>/dev/null || true

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

# npm 을 거치지 않고 next 를 직접 실행한다. npm 래퍼가 끼면 Ctrl+C 신호가 제대로 전달되지 않거나
# next-server 가 끝난 뒤에도 npm 프로세스가 남을 수 있다.
NEXT="./node_modules/.bin/next"
[[ -x "$NEXT" ]] || { echo "web/node_modules 가 없습니다. 먼저 ./setup-comfyui.sh 또는 (cd web && npm install) 을 실행하세요."; exit 1; }
ensure_node_on_path || { echo "node 를 찾을 수 없습니다. nvm 이라면 ~/.nvm/versions/node/*/bin 을 확인하세요."; exit 1; }

case "$MODE" in
  dev)   exec "$NEXT" dev --port "$PORT" ;;
  build) exec "$NEXT" build ;;
  start)
    [[ -f .next/BUILD_ID ]] || "$NEXT" build
    exec "$NEXT" start --port "$PORT"
    ;;
  *) echo "알 수 없는 모드: $MODE (dev | build | start)"; exit 1 ;;
esac
