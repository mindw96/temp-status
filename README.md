# Lattice · 연구실 GPU & Slurm

현재 운영 중인 대시보드의 소스 저장소입니다. [대시보드 열기](https://lattice-lab-gpu.mindw96.chatgpt.site/) — 현재는 소유자 전용 비공개이며 이 저장소의 공개 범위와 별개입니다.

GitHub 업로드에는 웹 화면, 수신 API, D1 스키마, 수집기 연결 브리지를 포함합니다. 인증 토큰, 실제 보고 데이터, 배포 빌드, Sites 프로젝트 식별 파일은 포함하지 않습니다.

기존 `status_agent/agent.py`와 `slurm_agent.py`가 전송하는 JSON을 받는 연구실 대시보드입니다. 기존 운영 사이트는 Sites의 Cloudflare Worker와 D1, 소유자 전용 접근 정책을 사용합니다. 이 저장소의 루트 배포 설정은 별도 Cloudflare 계정의 `temp-status` Worker를 대상으로 합니다.

## 화면

- 실시간 보고와 명시적으로 분리된 가상 예시 모드
- 수신된 GPU 장치 수, 유효한 GPU 계측 평균, 실행/대기 작업
- 노드별 GPU 연산, 전체 VRAM 점유, CPU 및 RAM
- 작업명·사용자·ID 검색, 파티션/상태 필터, 12행 페이지 이동, 상세 정보
- GPU 사용 추이 및 파티션 현황 패널은 표시하지 않음. 기존 서버의 1분 단위 기록 저장은 유지.
- 5초 조회, 30초 이상 지연된 GPU 계측을 현재 평균에서 제외
- 노드 수신 시각과 Slurm 수신 시각을 별도로 표시

## 데이터 계약

`POST /api/report/node`와 `POST /api/report/slurm`는 기존 에이전트 JSON 형식을 받습니다. `X-Status-Token`은 Sites의 비밀 환경 변수 `STATUS_REPORT_TOKEN`과 일치해야 합니다. 원격 수집기가 비공개 Sites에 접근하려면 별도로 발급한 `OAI-Sites-Authorization: Bearer ...` 헤더가 필요합니다. 토큰은 소스, URL, 브라우저 JS, Git에 넣지 않습니다.

`GET /api/snapshot`은 로그인한 브라우저를 위해 최신 보고와 시계열을 반환합니다. 보고 원문 중 UI에 필요한 필드만 저장합니다. 서버가 생성한 수신 시각을 사용합니다. 기존 에이전트는 실제 수집 시각을 포함하지 않으므로 수신 시각과 수집 시각은 동일하지 않습니다.

GPU `vram_percent`는 프로세스 메모리의 합계이며 전체 VRAM이 아닙니다. 화면은 `vram_total_used_mb / vram_total_mb`를 사용합니다. 저장·표시 단위는 원래 바이트 계산에 맞춰 MiB/GiB로 해석합니다. `vram_utilization`을 메모리 용량 점유율로 쓰지 않습니다.

기존 payload에는 정확한 GPU GRES 할당, 노드별 파티션 목록, GPU 온도/전력, 작업 제출 시각이 없습니다. 따라서 프로세스가 관측된 GPU를 할당 GPU로 표시하지 않으며, 대기 작업의 실행 시간 0:00을 대기시간으로 해석하지 않습니다. Slurm 요청 GPU는 에이전트 보고값 그대로 보여주고 할당 합계에 쓰지 않습니다. 다중 노드 NodeList와 작업 배열 ID도 문자열 그대로 보존합니다. 과거 `sacct` 기록은 이 화면의 범위에 포함하지 않고 수신 응답에 `accounting_status: not_enabled`를 명시합니다.

## 기존 수집기를 보존하는 연결

`collector_bridge.py`는 기존 Python 모듈을 읽어서 새 목적지와 인증 헤더를 설정합니다. 원본 파일을 수정하거나 기존 프로세스를 중지하지 않습니다. 실행 환경은 기존 `/home/mindw/status_agent/.venv/bin/python`을 사용합니다. 노드 보고는 각 GPU 서버에서, Slurm 보고는 컨트롤러 하나에서 실행합니다.

자격 증명 파일 형식은 아래와 같습니다. 실제 값은 별도 비밀 파일에 저장하고 권한을 600으로 설정합니다.

```json
{"site_url":"<deployed-site-origin>","report_token":"<secret>","sites_bypass_token":"<secret>"}
```

```sh
python collector_bridge.py node --config /secure/path/lattice.json --once
python collector_bridge.py slurm --config /secure/path/lattice.json --once
```

`--once`는 JSON 성공 응답까지 검증합니다. 상시 실행할 때만 해당 옵션을 제거합니다. 다른 환경에 설치할 때는 대상 서버의 실제 사용자 홈과 서비스 관리 방식을 확인한 뒤 자동 시작을 등록합니다. 롤백은 새로 추가한 Lattice 수집 프로세스만 중지하면 됩니다.

## 개발 및 검증

Node 24와 pnpm을 사용합니다.

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm build
node scripts/test-worker.mjs
pnpm deploy:check
node scripts/preview.mjs
```

마이그레이션은 `drizzle/`에서 Sites 배포 전에 적용됩니다. 로컬 미리보기는 127.0.0.1:4173의 메모리 SQLite를 사용하며 로그인 사용자를 모의합니다. 로컬 수신용 토큰은 `preview-local-only`이고 배포 코드에는 포함되지 않습니다. 운영 DB는 별도의 영구 D1입니다.

검증: 인증 없는 POST/GET 거부, 입력 오류, 빈 작업 목록, 0과 null의 구분, 업데이트/분 단위 이력, 저장 실패 응답, 실제 에이전트의 GPU 8개/Slurm 작업 89개 스냅샷 호환성을 확인했습니다. 이 수치는 테스트 당시의 일회성 관측이며 현재 클러스터 값이 아닙니다.

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

## 실시간 데이터 이전에 남은 설정

Worker 배포와 실제 클러스터 데이터 이전은 별도 단계입니다. 기존 Sites와 Server1~4 수집기는 기존 목적지를 계속 사용합니다.

1. 첫 배포 후 Cloudflare에서 생성된 D1의 이름·ID를 확인해 루트 설정의 `DB` 항목에 기록하고, `pnpm db:migrate:remote`로 테이블을 생성합니다. 로컬 검증에는 `pnpm db:migrate:local`을 사용합니다.
2. Workers의 **Settings → Variables & Secrets**에서 런타임 Secret `STATUS_REPORT_TOKEN`을 설정합니다. Build 전용 변수에만 넣으면 런타임에서 사용할 수 없습니다.
3. 브라우저의 실시간 조회 인증을 Cloudflare Access 등 새 환경의 인증 방식으로 구현합니다. 독립 Worker는 Sites 사용자 헤더를 신뢰할 수 없으므로 현재 루트 설정은 `SNAPSHOT_AUTH_MODE=unconfigured`로 실시간 조회를 차단합니다(`503 access_not_configured`). 해당 값을 제거하거나 `oai-authenticated-user-id` 헤더를 임의로 추가하는 방식으로 우회하지 않습니다. 로컬 미리보기의 Sites 사용자 모의와 기존 운영 Sites 인증은 별개입니다.
4. `collector_bridge.py`의 Sites 전용 토큰 처리와 각 서버의 전송 URL·인증 정보를 새 환경에 맞게 변경한 뒤, 실제 수신을 확인합니다. 현재 브리지는 기존 Sites 연결용입니다.

화면과 API를 함께 실행하는 Cloudflare Workers + D1 구성이 현재 코드와 맞습니다. GitHub Pages는 정적 화면만 제공하므로 별도 백엔드가 필요합니다.
