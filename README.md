# Lattice · 연구실 GPU & Slurm

연구실 GPU·Slurm 대시보드의 소스 저장소입니다. 현재 기본 배포 주소는 **[Render 대시보드](https://temp-status.onrender.com/)**이며 로그인 없이 열람할 수 있습니다. 이미 생성된 서비스이므로 대시보드를 열기 위해 새 Blueprint나 서비스를 만들 필요는 없습니다. 설정과 새 환경에 배포하는 방법은 [Render 운영 안내](RENDER_SETUP.md)를 참고하세요.

Render에서는 동일한 화면과 API를 Node 서버로 실행하며 최신 보고만 메모리에 보관합니다. 홈페이지 배포와 수집기 연결은 별도이므로 실제 데이터 수신 여부는 화면의 노드·Slurm 보고 시각으로 확인합니다. [Cloudflare 대체 배포](https://temp-status.mindw96-3c8.workers.dev/)의 설치 방법은 [Cloudflare 설정 안내](SETUP.md)에 유지합니다. [기존 Sites 대시보드](https://lattice-lab-gpu.mindw96.chatgpt.site/)는 별도의 비공개 배포입니다.

GitHub 업로드에는 웹 화면, 수신 API, D1 스키마, 수집기 연결 브리지를 포함합니다. 인증 토큰, 실제 보고 데이터, 배포 빌드, Sites 프로젝트 식별 파일은 포함하지 않습니다.

기존 `status_agent/agent.py`와 `slurm_agent.py`가 전송하는 JSON을 받는 연구실 대시보드입니다. `render.yaml`은 현재 Render 배포를, `wrangler.jsonc`는 별도 Cloudflare 계정의 `temp-status` Worker와 D1 배포를 설정합니다. 기존 Sites 배포는 소유자 전용 접근 정책을 사용합니다.

## 화면

- 실시간 보고와 명시적으로 분리된 가상 예시 모드
- Server1~4의 GPU별 Job ID·사용자·작업명과 Baro의 GPU별 사용자·프로세스 수
- 노드별 GPU 연산, 전체 VRAM 점유, CPU 및 RAM
- 작업명·사용자·ID 검색, 파티션/상태 필터, 12행 페이지 이동, 상세 정보
- GPU 사용 추이 및 파티션 현황 패널은 표시하지 않으며 이력 저장·조회도 수행하지 않음
- 수집기 15초 전송, 화면 30초 조회. 90초 이상 지연되거나 조회 실패한 계측은 현재 값으로 표시하지 않음
- 노드 수신 시각과 Slurm 수신 시각을 별도로 표시

## 화면 수정과 자동 배포

화면 구성과 문구는 `public/index.html`, 색상·간격·레이아웃은 `public/styles.css`, 공통 화면 기능과 노드 표시 이름은 `public/app.js`, 실제 수신 데이터 표시는 `public/live.js`에서 수정합니다. `public/app.js`의 `nodeDisplayNames`는 `devbox → Server1`, `server2 → Server2`, `ubuntu → Server3`, `server4 → Server4`, `baro-1 → Baro`를 화면에만 적용합니다. 수집기와 DB의 hostname, 노드 연결 키는 변경하지 않습니다.

수정 후 `pnpm run build`로 확인하고 변경 파일을 커밋해 `main`에 푸시합니다. Git 자동 배포가 켜져 있으면 연결된 Render 서비스가 새 코드를 배포하며, 진행 상황은 기존 `temp-status` 서비스의 Events에서 확인합니다. Cloudflare Workers Builds 연결도 별도로 유지됩니다. 각 호스팅 편집기에서 코드를 따로 수정하기보다 이 저장소를 기준으로 관리합니다.

## 데이터 계약

`POST /api/report/node`와 `POST /api/report/slurm`는 기존 연구실 에이전트 JSON 형식을 받습니다. `POST /api/report/cloud-gpu`는 Baro의 `cloud_gpu_agent.py`가 보내는 `server`, `system`, `gpus` 형식을 받아 독립 클라우드 노드로 저장합니다. `X-Status-Token`은 수신 서버의 비밀 환경 변수 `STATUS_REPORT_TOKEN`과 일치해야 합니다. 공개 열람을 선택해도 데이터 전송 인증은 유지됩니다. 토큰은 소스, URL, 브라우저 JS, Git에 넣지 않습니다. 기존 비공개 Sites로 전송하는 경우에만 별도의 `OAI-Sites-Authorization: Bearer ...` 헤더가 추가로 필요합니다.

`GET /api/snapshot`은 최신 보고만 반환합니다. 호환성을 위해 `history`는 빈 배열로 반환하며 기존 이력 테이블과 데이터는 삭제하지 않습니다. 현재 Render와 Cloudflare 설정은 `SNAPSHOT_AUTH_MODE=public`으로 로그인 없이 조회할 수 있습니다. 기존 Sites 모드는 플랫폼 사용자 인증을 유지합니다. 보고 원문 중 UI에 필요한 필드만 저장하고 서버가 생성한 수신 시각을 사용합니다. 기존 에이전트는 실제 수집 시각을 포함하지 않으므로 수신 시각과 수집 시각은 동일하지 않습니다.

GPU `vram_percent`는 프로세스 메모리의 합계이며 전체 VRAM이 아닙니다. 화면은 `vram_total_used_mb / vram_total_mb`를 사용합니다. 저장·표시 단위는 원래 바이트 계산에 맞춰 MiB/GiB로 해석합니다. `vram_utilization`을 메모리 용량 점유율로 쓰지 않습니다.

기존 payload에는 정확한 GPU GRES 할당, 노드별 파티션 목록, GPU 온도/전력, 작업 제출 시각이 없습니다. 따라서 프로세스가 관측된 GPU를 할당 GPU로 표시하지 않으며, 대기 작업의 실행 시간 0:00을 대기시간으로 해석하지 않습니다. Slurm 요청 GPU는 에이전트 보고값 그대로 보여주고 할당 합계에 쓰지 않습니다. 다중 노드 NodeList와 작업 배열 ID도 문자열 그대로 보존합니다. 과거 `sacct` 기록은 이 화면의 범위에 포함하지 않고 수신 응답에 `accounting_status: not_enabled`를 명시합니다.

## 기존 수집기를 보존하는 연결

`collector_bridge.py`는 기존 Python 모듈을 읽어서 새 목적지와 인증 헤더를 설정합니다. 원본 파일을 수정하거나 기존 프로세스를 중지하지 않습니다. 실행 환경은 기존 `/home/mindw/status_agent/.venv/bin/python`을 사용합니다. 노드 보고는 각 GPU 서버에서, Slurm 보고는 컨트롤러 하나에서 실행합니다.

자격 증명 파일 형식은 아래와 같습니다. 실제 값은 별도 비밀 파일에 저장하고 권한을 600으로 설정합니다.

```json
{"site_url":"https://temp-status.onrender.com","auth_mode":"cloudflare","report_token":"<secret>"}
```

```sh
python collector_bridge.py node --config /secure/path/lattice.json --once
python collector_bridge.py slurm --config /secure/path/lattice.json --once
```

`--once`는 JSON 성공 응답까지 검증합니다. 상시 실행할 때만 해당 옵션을 제거합니다. 다른 환경에 설치할 때는 대상 서버의 실제 사용자 홈과 서비스 관리 방식을 확인한 뒤 자동 시작을 등록합니다. 롤백은 새로 추가한 Lattice 수집 프로세스만 중지하면 됩니다.

`auth_mode: cloudflare`는 Render에서도 사용하는 전송 토큰 인증 방식입니다. 기본 전송 주기는 15초이며 설정 파일의 `report_interval_sec`로 1~300초 범위에서 변경할 수 있습니다. 실패 시 재시도 간격을 최대 5분까지 늘리고, 성공하면 기본 주기로 돌아갑니다. 화면은 정상 상태에서 30초마다 조회하고 D1 일일 한도 초과 시 재설정 시각을 표시합니다. 이미 소진된 일일 한도는 코드 배포로 초기화되지 않으며 UTC 자정(한국 시간 오전 9시)에 초기화됩니다. [D1 요금제와 한도](https://developers.cloudflare.com/d1/platform/pricing/)

기존 Sites용 설정은 `auth_mode` 생략 또는 `sites`를 사용하며 `sites_bypass_token`도 필요합니다. Cloudflare 설치 도구 `scripts/install-collectors.py`는 기존 Lattice 서비스와 원본 에이전트를 유지하고 별도 서비스를 등록합니다.

## Baro 클라우드 노드

Baro는 Slurm을 사용하지 않는 독립 서버입니다. 보고 ID `baro-1`을 보존하고 화면에는 `Baro`로 표시합니다. 클라우드 보고는 기존 Slurm 스냅샷을 덮어쓰지 않으며, GPU의 사용자·프로세스를 연구실 Job ID와 연결하지 않습니다. GPU 메모리 값은 MiB로 받아 GiB로 표시합니다.

원본 에이전트는 `/home/mindw/baro1-status-agent/cloud_gpu_agent.py`입니다. 브리지는 이 모듈을 그대로 읽고, 별도 인증 설정의 `site_url`에 있는 `/api/report/cloud-gpu`로 전송합니다. 원본 `agent.env`, 코드 및 PM2의 `baro1-agent`는 보존합니다.

클라우드 브리지 설정은 기존 JSON 형식에 `"server_name":"baro-1"`, `"disk_path":"/home"`을 추가합니다. 인증 파일은 권한 600으로 저장합니다. 일회성 전송 검증은 다음과 같습니다.

```sh
python collector_bridge.py cloud-gpu \
  --agent-dir /home/mindw/baro1-status-agent \
  --config /secure/path/cloudflare.json --once
```

운영 연결은 `/home/mindw/baro1-status-agent/cloudflare-status/`와 systemd 사용자 서비스 `cloudflare-status-cloud-gpu.service`를 사용합니다. 사용자 lingering을 활성화해 로그아웃 이후와 부팅 시에도 서비스를 실행합니다. 상태 확인과 새 연결만 중지하는 명령은 다음과 같습니다.

```sh
ssh Baro 'systemctl --user status cloudflare-status-cloud-gpu.service --no-pager'
ssh Baro 'systemctl --user disable --now cloudflare-status-cloud-gpu.service'
```

## 개발 및 검증

Node 24와 pnpm을 사용합니다.

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm build
node scripts/test-worker.mjs
node scripts/test-gpu-jobs.mjs
python3 scripts/test-collector-bridge.py
pnpm deploy:check
node scripts/preview.mjs
```

마이그레이션은 `drizzle/`에서 Sites 배포 전에 적용됩니다. 로컬 미리보기는 127.0.0.1:4173의 메모리 SQLite를 사용하며 로그인 사용자를 모의합니다. 로컬 수신용 토큰은 `preview-local-only`이고 배포 코드에는 포함되지 않습니다. Cloudflare 배포는 영구 D1을 사용하고, Render 배포는 최신 보고만 메모리에 보관합니다.

검증: 전송 인증, 공개/비공개 조회 정책, 입력 오류, 빈 작업 목록, 0과 null의 구분, 최신 보고 덮어쓰기, 이력 접근 제거, 한도 초과 응답과 UTC 재설정 경계, 수집기 재시도 간격을 검사합니다. 브라우저에서는 한도 안내, 수동 재시도, 30초 조회/90초 유효 기간, 이전 데이터의 지연 표시와 모바일 레이아웃을 확인합니다.

## Cloudflare Workers 배포

Cloudflare에서 이 저장소의 `main` 브랜치를 연결한 뒤, Worker의 **Settings → Build**에서 아래 값을 사용합니다.

| 설정 | 값 |
| --- | --- |
| Worker 이름 | `temp-status` |
| Root directory | 저장소 루트 |
| Build command | `pnpm run build` |
| Deploy command | `pnpm run deploy` |

기존 `npx wrangler deploy` 명령도 저장소에 고정한 Wrangler와 루트 설정을 사용하므로 그대로 실행할 수 있습니다. `pnpm deploy:check`는 실제 게시 없이 번들·설정을 검사합니다.

`wrangler.jsonc`의 `main`은 화면과 API를 함께 제공하는 `dist/server/index.js`입니다. `dist/`를 static assets 디렉터리로 설정하지 않습니다. 이 폴더에는 서버 코드도 포함되어 있습니다. 빌드 시 Sites용 Wrangler 설정이나 가짜 데이터베이스 ID를 생성하지 않습니다.

Wrangler는 `package.json`과 lockfile에 고정되어 있으며, `pnpm-workspace.yaml`은 `esbuild`와 `workerd`에만 설치 스크립트 실행을 허용합니다. `ERR_PNPM_IGNORED_BUILDS`를 피하기 위해 CI에서 대화형 `pnpm approve-builds`를 실행하거나 전체 패키지에 스크립트 실행을 허용할 필요가 없습니다.

루트 설정의 `DB`는 첫 배포 시 Wrangler가 D1을 자동 생성·연결하는 바인딩입니다. Workers Builds용 API 토큰에 계정의 **D1 Edit** 권한이 필요합니다. 권한이 없다는 오류가 발생하면 Cloudflare의 **My Profile → API Tokens**에서 해당 빌드 토큰을 수정하거나 필요한 권한을 가진 토큰을 Build 설정에 지정합니다. 기존 데이터베이스를 연결하려면 `wrangler.jsonc`의 `DB` 항목에 실제 `database_name`과 `database_id`를 추가합니다.

[Workers Builds 설정](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/), [D1 자동 생성](https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/), [pnpm 패키지 실행 정책](https://pnpm.io/settings#allowbuilds)

## Cloudflare 실시간 데이터 연결

Worker 배포와 실제 클러스터 데이터 이전은 별도 단계입니다. 기존 Sites와 Server1~4 수집기는 기존 목적지를 계속 사용합니다.

1. `pnpm exec wrangler d1 info DB`로 조회한 DB가 Cloudflare Worker의 `DB` 바인딩과 같은지 확인하고, `pnpm run db:migrate:remote`로 테이블을 생성합니다. 로컬 검증에는 `pnpm run db:migrate:local`을 사용합니다. 현재 자동 생성 이름은 `temp-status-db`이며, 직접 이름을 바꾸거나 다른 DB에 연결했다면 루트 설정의 `DB`에 해당 이름과 ID를 추가해야 합니다.
2. Workers의 **Settings → Variables & Secrets**에서 런타임 Secret `STATUS_REPORT_TOKEN`을 설정합니다. Build 전용 변수에만 넣으면 런타임에서 사용할 수 없습니다.
3. 현재 루트 설정은 사용자가 선택한 공개 열람(`SNAPSHOT_AUTH_MODE=public`)입니다. 별도의 로그인 설정이 필요하지 않습니다.
4. [단계별 안내](SETUP.md)의 설치 명령으로 각 서버에 별도 Cloudflare 수집기를 등록한 뒤 실제 수신을 확인합니다.

화면과 API를 함께 실행하는 Cloudflare Workers + D1 구성이 현재 코드와 맞습니다. GitHub Pages는 정적 화면만 제공하므로 별도 백엔드가 필요합니다.
