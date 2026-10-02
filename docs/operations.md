# 운영 기록: Mac mini 배포

2026-09-29 기준 구성입니다. 실행 상태와 DNS는 바뀔 수 있으므로 아래 명령으로 현재 상태를 먼저 확인합니다.

## 서비스 구성

| 항목 | 위치·설정 |
| --- | --- |
| 호스트 | SSH 별칭 `jaesol-macmini`, 저장소 `~/Documents/GitHub/qwen-image-studio` |
| 웹 앱 | Next.js 프로덕션 서버, `127.0.0.1:3210` |
| 인증 프록시 | Basic Auth, `127.0.0.1:3211`, 사용자 이름 `qwen` |
| ComfyUI | `127.0.0.1:8188`, Apple Silicon MPS, `--lowvram` |
| 외부 주소 | `https://studio.jaesolshin.com` → Cloudflare Named Tunnel → 인증 프록시 |
| 터널 | `qwen-image-studio-macmini`, ID `c5a75deb-26c0-4077-bbb9-fe8340cf9f78` |

`run-studio-services.sh`가 네 서비스를 `nohup`으로 시작합니다. 로그인 자동 실행이나 LaunchAgent는 사용하지 않습니다. 스크립트는 대기·생성 중인 작업이 있으면 `stop`과 `restart`를 거부합니다.

```bash
ssh jaesol-macmini
cd ~/Documents/GitHub/qwen-image-studio
./run-studio-services.sh start    # 중지된 서비스 시작
./run-studio-services.sh status   # ComfyUI 200, 앱 200, 프록시 401, 터널 running 확인
./run-studio-services.sh logs     # 종료: Ctrl+C
./run-studio-services.sh stop     # 작업이 없을 때만 전체 중지
./run-studio-services.sh --force restart  # 멈춘 서비스 복구용 (대기·생성 중 작업이 있어도 중지)
```

`--force` 는 서비스가 멈춰 작업을 진행할 수 없을 때만 씁니다. 작업 목록(`web/data/jobs.json`)은 지우지 않으므로,
재시작 후 워커가 대기 중 작업을 이어서 처리합니다.

## 파일 디스크립터 한도

macOS 기본 soft limit(256)은 라이브러리 매핑만으로 소진되어 ComfyUI 가 `OSError: [Errno 24] Too many open files`
로 소켓을 받지 못하고 모델 로딩에서 멈춘다. `run-comfyui.sh` 와 `run-studio-services.sh` 의 `start_comfy` 가
`ulimit -n 65536` 으로 상향한 뒤 실행한다. 커널 상한(`kern.maxfilesperproc`)은 92160 이라 여유가 있다.

SSH 비대화형 명령에서는 Homebrew가 PATH에 없을 수 있으므로 `export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH`를 먼저 실행합니다. 로그는 `~/Library/Logs/Qwen Image Studio/`에 있습니다. 비밀번호와 터널 토큰은 `~/Library/Application Support/Qwen Image Studio/`의 권한 600 파일로 보관하며 저장소에 넣지 않습니다.

## 모델과 생성 백엔드

Mac mini의 `ComfyUI/models/`에 다음 파일을 설치했습니다.

- `diffusion_models/qwen-image-2.1-Q8_0.gguf` — 기본 선택
- `diffusion_models/qwen-image-2.1-Q4_K_M.gguf` — 저메모리 선택
- `text_encoders/qwen3vl_8b_int8_convrot.safetensors`
- `vae/qwen_image_2.1_vae_bf16.safetensors`

ComfyUI, ComfyUI-GGUF, 프로젝트의 Qwen3-VL 보완 노드가 설치돼 있습니다. `GET http://127.0.0.1:3210/api/status`에서 `comfy.reachable: true`와 두 GGUF 파일 및 텍스트 인코더가 표시되는 것을 확인했습니다. 실제 이미지 생성 작업은 아직 실행해 확인하지 않았습니다. Heretic GGUF 텍스트 인코더와 `mmproj`는 Mac mini에 설치하지 않았습니다.

## DNS와 터널

도메인은 Vercel에서 등록·갱신하고, 권한 있는 네임서버는 Cloudflare의 `laila.ns.cloudflare.com`과 `marek.ns.cloudflare.com`입니다. Cloudflare Free 영역의 주요 레코드는 다음과 같습니다.

| 이름 | 레코드 | 대상 | 프록시 |
| --- | --- | --- | --- |
| `@` | CNAME | `c326847e53b850af.vercel-dns-017.com` | DNS only |
| `*` | CNAME | `cname.vercel-dns-017.com` | DNS only |
| `studio` | Tunnel | 위 Named Tunnel의 `http://127.0.0.1:3211` | Proxied |

기존 CAA 3개와 `_domainconnect` CNAME도 Cloudflare에 보존했습니다. 외부 주소는 인증 전 401, 인증 후 200이 정상입니다. 메인 `https://jaesolshin.com`은 Vercel에서 계속 제공됩니다.

네임서버 전환 직후 예전 Vercel DNS를 기억하는 중계 서버에서 Studio가 404를 반환했습니다. 이를 완화하기 위해 **예전 Vercel DNS 영역**에 `studio` A 레코드 2개를 임시로 추가했습니다: `104.21.35.24` (`rec_38ec039ef6aeafd33606b2e0`), `172.67.211.160` (`rec_e5a366c08020396776978d57`). 이 IP는 영구 설정으로 사용하지 않습니다. 예전 네임서버 캐시가 사라진 것이 확인되면 두 임시 레코드를 제거할 수 있습니다.

전파 중 접속용 Quick Tunnel도 별도 프로세스로 띄웠습니다. 이것은 Named Tunnel과 달리 `run-studio-services.sh`의 관리 대상이 아닙니다. 로그 `~/Library/Logs/Qwen Image Studio/quick-fallback.log`, PID 파일 `quick-fallback.pid`에 기록돼 있습니다. 고정 주소 접속이 안정되면 이 임시 프로세스를 종료합니다.

## 배포 시 주의

웹 앱을 교체하기 전에 `http://127.0.0.1:3210/api/jobs`에서 대기·생성 중인 작업을 확인합니다. `web/data/`, `outputs/`, 모델 파일, 비밀번호·터널 토큰은 배포 파일과 구분해 보존합니다. Mac mini의 체크아웃과 로컬 저장소에는 각각 독립적인 미커밋 변경이 있을 수 있으므로 동기화 전 diff를 확인합니다.
