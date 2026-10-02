# Qwen Image Studio 웹 앱

Next.js 16 + shadcn/ui 로 만든 Qwen-Image-2.1 생성 UI 입니다. 설치와 실행 방법, 구조 설명은 저장소 루트의 [README](../README.md) 에 있습니다.

```bash
npm install
npm run dev -- --port 3210   # 개발 모드
npm run build && npm run start -- --port 3210
```

환경변수: `PORT`, `COMFY_URL`(기본 http://127.0.0.1:8188), `COMFY_AUTOSTART`(0 이면 자동 시작 끔), `QWEN_ROOT`(기본 상위 폴더).

## 실패 작업 자동 재시도

엔진 오류나 일시적 연결 문제로 작업이 실패하면 서버가 같은 작업을 자동으로 다시 대기열에 넣습니다.
시도는 최초 실행을 포함해 `QWEN_MAX_ATTEMPTS`(기본 3)회까지이고, 재시도 사이에는
`QWEN_RETRY_DELAY_MS`(기본 3000ms)를 기준으로 지수 백오프로 기다립니다.
사용자가 취소한 작업은 재시도하지 않습니다. 모든 시도가 실패하면 그때 `failed` 로 남고 오류 메시지를 보존합니다.

서버가 재시작되면서 중단된 실행 중 작업도 같은 정책으로 다시 대기열에 들어갑니다.
재시도 정책은 `src/lib/server/retry.ts` 에서 관리합니다.
