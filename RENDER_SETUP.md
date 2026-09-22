# Render 배포 및 운영

현재 배포된 대시보드는 **[https://temp-status.onrender.com/](https://temp-status.onrender.com/)**입니다. 열람만 하실 때는 이 주소를 사용하시면 됩니다. 기존 `temp-status` 서비스가 있으므로 새 Blueprint나 Web Service를 추가로 만들 필요는 없습니다.

기존 서비스의 환경 변수와 배포 상태는 [Render Dashboard](https://dashboard.render.com/)에서 `temp-status`를 선택해 확인합니다. 아래 1~3단계는 **새 환경에 처음 배포하거나 서비스를 다시 구성할 때** 사용하는 절차입니다. 현재 서비스의 실제 수집기 수신 여부는 대시보드의 노드·Slurm 보고 시각으로 확인합니다.

현재 화면과 수신 API를 하나의 Render **Web Service**에서 실행합니다. 별도의 DB를 만들지 않고 최신 GPU·Slurm 보고만 메모리에 저장하므로 Cloudflare D1의 일일 읽기·쓰기 한도에 영향을 받지 않습니다.

## 1. 기존 전송 토큰 복사

이전에 Cloudflare 연결에 사용한 Mac에서 다음 명령을 실행합니다. 토큰을 화면에 출력하지 않고 클립보드에 복사합니다.

```sh
pbcopy < "$HOME/Projects/temp-status/.secrets/report-token"
```

이 파일은 현재 Server1~4와 Baro 수집기의 전송 토큰과 일치하는 것으로 확인했습니다. 토큰 값을 GitHub나 채팅에 올리지 마세요. 다른 Mac이나 토큰이 변경된 환경에서는 먼저 실제 수집기와 일치하는 토큰을 확인해야 합니다.

## 2. 새 환경에서 Blueprint 생성

1. [Render Dashboard](https://dashboard.render.com/)에서 **New → Blueprint**를 선택합니다.
2. GitHub를 연결하고 **mindw96/temp-status** 저장소를 선택합니다.
3. Branch는 **main**, Blueprint Path는 **render.yaml**로 둡니다.
4. `STATUS_REPORT_TOKEN` 입력란에 복사한 토큰을 붙여 넣습니다.
5. 생성 대상이 **Free Web Service 하나**인지 확인하고 **Deploy Blueprint**를 누릅니다.

`render.yaml`에 Node 버전, 무료 인스턴스, 빌드·실행 명령이 포함되어 있습니다. DB, 유료 디스크, 유료 인스턴스를 추가하지 않습니다.

Blueprint 대신 **New → Web Service**를 사용할 경우 아래 설정을 직접 입력합니다.

| 항목 | 값 |
| --- | --- |
| Repository | `mindw96/temp-status` |
| Branch | `main` |
| Language / Runtime | `Node` |
| Region | `Singapore` |
| Build Command | `node scripts/build.mjs` |
| Start Command | `node scripts/render-server.mjs` |
| Instance Type | `Free` |
| Environment: `NODE_VERSION` | `24.19.0` |
| Environment: `SNAPSHOT_AUTH_MODE` | `public` |
| Environment: `STATUS_REPORT_TOKEN` | 위에서 복사한 기존 토큰 |

## 3. 배포 확인과 수집기 연결

현재 서비스 주소는 `https://temp-status.onrender.com`이며 상태 확인 경로는 [/healthz](https://temp-status.onrender.com/healthz)입니다. 별도 서비스를 새로 만든 경우에는 Render가 표시한 해당 서비스 주소를 사용합니다. 홈페이지와 `/healthz` 응답은 서버 실행을 확인하는 것이며, 실제 GPU·Slurm 수신은 대시보드의 보고 시각을 별도로 확인해야 합니다. 새 배포는 수집기 목적지를 연결하기 전까지 GPU 데이터가 비어 있습니다.

새 주소를 확인한 뒤 Server1~4와 Baro의 별도 대시보드 수집기 설정에서 `site_url`을 해당 HTTPS 주소로 변경하고 서비스를 재시작합니다. 원본 연구실 수집기와 Sites 연결은 보존합니다. 이 저장소 브리지의 `auth_mode: cloudflare`는 `X-Status-Token` 인증 방식을 뜻하므로 Render에서도 그대로 사용할 수 있습니다.

기존 서비스의 코드만 업데이트할 때는 수집기 주소나 토큰을 다시 설정할 필요가 없습니다. 서비스를 다른 주소로 옮길 때만 수집기의 `site_url`을 변경하고 다섯 노드·Slurm 보고 수신을 검증합니다. 토큰 값은 GitHub나 채팅으로 전달하지 않습니다.

## 무료 운영의 범위

- 이 배포는 최신 상태만 보관합니다. 재배포·재시작 시 메모리가 초기화되며, 서비스가 다시 열린 후 다음 정상 수집으로 채워집니다. 정상 수집 간격은 15초이며, 오류가 이어진 경우 최대 5분 재시도 대기가 적용될 수 있습니다.
- Render Free는 15분 동안 들어오는 요청이 없으면 절전 상태가 되고, 재시작할 수 있습니다. 실제 수집 보고가 계속 들어오는 동안에는 일반적으로 유휴 조건에 해당하지 않습니다. 서비스 가용성은 보장되지 않습니다.
- Free 인스턴스 시간은 workspace 합계 월 750시간입니다. Hobby의 포함 전송량은 월 5GB이며 다른 서비스 사용량과 합산됩니다. 이 서버는 응답 압축과 30초 화면 조회로 전송량을 줄입니다.
- 포함 전송량을 넘으면 결제수단이 있는 경우 추가 요금, 없는 경우 서비스 중단이 발생할 수 있으므로 Billing의 사용량을 확인합니다.
- Render Free Postgres는 30일 후 만료되므로 이 배포에 추가하지 않습니다.

[Render 무료 제한](https://render.com/docs/free), [Render 요금제](https://render.com/pricing), [전송량 정책](https://render.com/docs/outbound-bandwidth), [Blueprint 배포](https://render.com/docs/infrastructure-as-code)
