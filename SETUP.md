# Cloudflare 빌드 이후 연결하기

대상 사이트: https://temp-status.mindw96-3c8.workers.dev/

모든 명령은 **Mac 터미널의 같은 창**에서 순서대로 실행합니다. 직접 Server1에 SSH로 들어가 실행하는 명령이 아닙니다. 어느 단계에서 오류가 나면 다음 단계로 넘어가지 말고 오류 문구를 확인합니다.

공개 열람 모드는 코드에 반영되어 있습니다. 아래에서 만드는 토큰은 서버가 데이터를 보낼 때만 사용하는 값이며, 사이트 방문자는 로그인이나 토큰이 필요하지 않습니다.

## 1. Mac에서 실행 도구 준비

현재 Mac에 설치되어 있는 Codex의 Node 24와 pnpm 11을 사용합니다. 다음은 현재 터미널 창에만 실행 경로를 추가합니다.

```sh
export PATH="/Users/mindw/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/mindw/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:$PATH"
node --version
pnpm --version
```

각각 `v24...`, `11.19.0`이 표시되면 준비됐습니다. 다른 컴퓨터에서는 Node 24와 pnpm 11.19.0을 먼저 설치합니다.

## 2. 저장소 받기

iCloud 동기화 영향을 피하도록 `Projects` 아래에 받습니다.

```sh
mkdir -p "$HOME/Projects"
cd "$HOME/Projects"
git clone https://github.com/mindw96/temp-status.git
cd temp-status
pnpm install --frozen-lockfile
```

`$HOME/Projects/temp-status`에 이미 이 저장소를 받았다면 clone 대신 아래 명령을 사용합니다.

```sh
cd "$HOME/Projects/temp-status"
git pull --ff-only
pnpm install --frozen-lockfile
```

## 3. Cloudflare 로그인

```sh
pnpm exec wrangler login
pnpm exec wrangler whoami
```

브라우저가 열리면 현재 `temp-status`를 만든 Cloudflare 계정으로 로그인하고 **Allow**를 누릅니다. `whoami`가 로그인한 계정을 표시하면 완료입니다.

## 4. 데이터베이스 초기화

D1은 서버가 보내는 상태를 저장하는 데이터베이스입니다. 먼저 이미 연결된 DB를 조회합니다.

```sh
pnpm exec wrangler d1 info DB
```

Cloudflare 화면에서 **Workers & Pages → temp-status → Bindings → DB**를 열어 위 명령에 나온 데이터베이스 이름과 ID가 같은지 확인합니다. 현재 설정의 기본 자동 생성 이름은 `temp-status-db`입니다. 다르거나 찾을 수 없다고 나오면 새로운 DB를 만들지 말고 연결된 이름과 ID부터 확인합니다.

일치하면 테이블을 만듭니다.

```sh
pnpm run db:migrate:remote
```

계속할지 묻는 질문에는 `y`를 입력합니다. 마지막에 마이그레이션 상태가 성공이면 완료입니다. 아래 명령으로 확인할 수 있습니다.

```sh
pnpm exec wrangler d1 execute DB --remote --command "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;"
```

목록에 `reports`, `gpu_history`, `d1_migrations`가 있으면 정상입니다. 이 단계는 저장소의 SQL을 실제 Cloudflare DB에 적용합니다. [D1 마이그레이션 공식 문서](https://developers.cloudflare.com/d1/reference/migrations/)

## 5. 서버 전송용 토큰 생성·등록

아래 명령은 임의 토큰을 로컬 비밀 파일에 저장하고 Cloudflare의 `STATUS_REPORT_TOKEN`으로 등록합니다. 이미 같은 파일이 있다면 토큰을 다시 만들지 않습니다.

```sh
mkdir -p .secrets
chmod 700 .secrets
umask 077
test -s .secrets/report-token || openssl rand -hex 32 > .secrets/report-token
chmod 600 .secrets/report-token
pnpm exec wrangler secret put STATUS_REPORT_TOKEN < .secrets/report-token
```

토큰 생성/등록 완료 메시지가 나오면 됩니다. `.secrets/`는 Git에서 제외했습니다. 파일 내용은 채팅에 보내지 않아도 됩니다. `secret put`은 Worker의 런타임 비밀 값을 등록하며 해당 버전을 즉시 배포합니다. [Cloudflare Secret 공식 문서](https://developers.cloudflare.com/workers/configuration/secrets/)

## 6. Server1~4 수집기 연결

아래 한 명령이 Mac의 기존 SSH 별칭으로 각 서버에 접속합니다.

```sh
python3 scripts/install-collectors.py \
  --site https://temp-status.mindw96-3c8.workers.dev \
  --token-file .secrets/report-token \
  --hosts Server1 Server2 Server3 Server4
```

이 설치 도구가 수행하는 작업은 다음과 같습니다.

- 원본 `agent.py`, `slurm_agent.py`, 기존 Sites 수집 서비스를 유지합니다.
- 임시 설정으로 새 사이트에 보고를 한 번 보내 성공 여부를 확인합니다.
- 각 서버에 `cloudflare-status-node.service`를 설치합니다.
- Server1에는 `cloudflare-status-slurm.service`도 설치합니다.
- 토큰은 서버의 비밀 설정 파일에 저장하며 화면에 출력하지 않습니다.
- Server4를 포함해 실제 사용자 홈 아래에 systemd 사용자 서비스를 등록합니다.

SSH 비밀번호 없이 접속 가능한 기존 키를 사용합니다. `Permission denied` 또는 호스트 키 확인 오류가 나오면 먼저 같은 Mac 터미널에서 `ssh Server1`처럼 해당 서버에 정상 접속되는지 확인하고, `exit`로 Mac에 돌아와 위 명령을 다시 실행합니다. 설치 도구는 SSH 호스트 키 검증을 끄지 않습니다.

## 7. 사이트 확인·공유

브라우저에서 대상 사이트를 새로고침하고 5~10초 정도 기다립니다.

- 데이터 모드는 **실시간**으로 둡니다.
- GPU 노드 보고가 4개 들어오는지 확인합니다.
- Slurm 수신 시각이 갱신되는지 확인합니다.
- 별도 시크릿 창에서도 로그인 없이 볼 수 있는지 확인합니다.

정상적으로 표시되면 연구실 구성원에게 사이트 주소를 공유하면 됩니다.

수집기 상태를 터미널에서 확인하려면:

```sh
ssh Server1 'systemctl --user status cloudflare-status-node.service cloudflare-status-slurm.service --no-pager'
ssh Server2 'systemctl --user status cloudflare-status-node.service --no-pager'
ssh Server3 'systemctl --user status cloudflare-status-node.service --no-pager'
ssh Server4 'systemctl --user status cloudflare-status-node.service --no-pager'
```

각 서비스가 `active (running)`이면 실행 중입니다. 최초 단발 보고 성공과 서비스 실행만으로 장기간 수신을 보장하지는 않으므로 화면의 수신 시각도 함께 확인합니다.

## 오류 문구별 확인할 곳

| 문구/상태 | 확인 |
| --- | --- |
| `command not found: node` 또는 `pnpm` | 1단계 PATH 명령을 같은 터미널 창에서 다시 실행 |
| D1을 찾을 수 없음 | 3단계 Cloudflare 계정과 4단계 실제 DB 바인딩 확인 |
| `storage_unavailable` / HTTP 503 | 4단계 테이블 생성과 DB 연결 확인 |
| `access_not_configured` | 최신 main 커밋의 Cloudflare 빌드 성공 여부 확인 |
| 단발 전송 HTTP 401 | 5단계 Secret과 6단계에서 읽는 토큰 파일이 같은지 확인 |
| SSH 실패 | 해당 서버 별칭으로 직접 SSH 접속 확인 |
| 화면이 `수신 대기` | 6단계 실행 결과와 systemd 서비스 상태 확인 |

이 안내의 Cloudflare 로그인, 운영 DB 초기화, 토큰 등록, 실제 서버 설치는 사용자가 실행하는 단계입니다. 안내 파일에 운영 토큰이나 기존 연구실 스냅샷은 포함하지 않습니다.
