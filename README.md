# OpenHermes Local Stack (llama.cpp + React UI + Extensible MCP)

이 저장소는 macOS 로컬 환경에서 `llama.cpp` 기반 Hermes와 React 웹 UI, CLI 오케스트레이션, MCP 서버 확장,
Slack/Discord webhook 프록시, 컴퓨터 사용(computer use)형 macOS 앱 제어, 그리고 GitHub Pages 배포까지 한 번에 관리할 수 있는 표준 구조를 제공합니다.

## 1) 목표 구성

- Local LLM: `llama.cpp` 서버
- 모델: `gemma-4-E4B-it-Q5_K_M.gguf`
- Hermes Base URL: `http://localhost:8080` (**`/v1` 붙이지 않음**)
- React UI: `npm run dev` 또는 `openhermes web`
- MCP: `mcp/servers` + `mcp/enabled` 기반 운영
- 활성 MCP: `filesystem`, `fetch`, `macos-automator`, `chrome-devtools`, `shell`, `local-memory`, `local-status`
- 배포: GitHub Pages + `gh-pages` 브랜치
- 컴퓨터 사용: `openhermes permissions`, `openhermes automate`
- 외부 진입점: `openhermes proxy --serve` 또는 `openhermes proxy --funnel`

## 2) 모델 경로 환경변수

```bash
export MODEL_PATH=/Users/robertlee/Workspace/Personal/localclaw/model/gemma-4-E4B-it-Q5_K_M.gguf
```

원하면 셸 시작 파일(`~/.zshrc`)에 추가:

```bash
echo 'export MODEL_PATH=/Users/robertlee/Workspace/Personal/localclaw/model/gemma-4-E4B-it-Q5_K_M.gguf' >> ~/.zshrc
source ~/.zshrc
```

## 3) CLI

`openhermes` 명령을 기준으로 로컬 서비스를 다룹니다.

```bash
npm run openhermes -- status
npm run openhermes -- start
npm run openhermes -- web
npm run openhermes -- proxy --funnel
npm run openhermes -- verify
npm run openhermes -- deploy-pages --proxy-url https://<your-tailscale-funnel-url>
```

서브커맨드:

- `start`: 기존 Hermes 백엔드와 MCP 브리지 시작
- `web`: React UI + API 프록시 시작
- `status`: Hermes, 프록시, MCP 상태 요약
- `permissions`: macOS 권한 상태 확인 또는 시스템 패널 열기
- `automate`: 앱 실행/포커스/URL 열기/시스템 패널 제어
- `control`: 자연어 프롬프트를 실행 계획으로 바꿔 실제 macOS 동작 실행
- `verify`: 로컬 Hermes/LLM/MCP 검증
- `deploy-pages`: `dist` 빌드 후 GitHub Pages 브랜치로 게시
- `proxy`: API 프록시만 시작, `--serve`는 tailnet URL, `--funnel`은 공개 URL

## 4) llama.cpp 서버 실행 표준

아래 명령으로 서버를 실행합니다.

```bash
./llama-server \
  -m "$MODEL_PATH" \
  -c 70000 \
  -ngl 999 \
  --host 127.0.0.1 \
  --port 8080
```

권장 사항:

- `-c 70000` 이상 유지 (에이전트 메모리/장문 처리 안정성)
- `-ngl 999`로 가능한 레이어 최대 GPU 오프로딩
- 실행 실패 시 VRAM 상황에 맞춰 `-c` 또는 배치 옵션을 조정

## 5) Hermes Agent Desktop 모델 연동

Hermes 앱에서 다음처럼 추가합니다.

1. `Models` 탭 → 새 모델 추가
2. `Provider`: `Local Provider`
3. `Base URL`: `http://localhost:8080` (중요: `/v1` 미포함)
4. `Model ID`: 실제 로드된 모델명 입력
5. `API Key`: 공란

## 6) Hermes Tools 활성화 체크리스트

`Tools` 탭에서 아래 항목을 모두 `ON`으로 변경합니다.

- `Web Search`
- `Browser`
- `Terminal`
- `File Operation`

## 7) MCP 운영 구조

이 저장소는 MCP를 아래 규약으로 운영합니다.

- `mcp/servers/`: MCP 서버 원본 설정(JSON)
- `mcp/enabled/`: 현재 활성 MCP 설정(JSON 또는 심볼릭 링크)
- `mcp/templates/`: 신규 MCP 생성 템플릿
- 자주 쓰는 샘플:
  - `fetch`: 웹 콘텐츠 가져오기용
  - `macos-automator`: Chrome/앱 AppleScript 제어
  - `chrome-devtools`: 실제 Chrome 탭 CDP 자동화
  - `shell`: 터미널 명령 실행 (고위험)
  - `sqlite`: 로컬 SQLite 조회용

자세한 사용법은 [`mcp/README.md`](./mcp/README.md)를 참고하세요.

## 7-1) Chrome 및 macOS 권한 MCP

실제 Chrome 앱(로그인·프로필 유지)과 macOS 앱/터미널 제어를 위해 아래 MCP가 활성화되어 있습니다.

| MCP | 역할 |
|-----|------|
| `macos-automator` | Chrome 실행/종료, URL 열기, 다른 앱 AppleScript |
| `chrome-devtools` | 실제 Chrome 탭 DOM 조작 (CDP) |
| `shell` | 터미널 명령 (`open`, `kill` 등) |
| `fetch` | JS 없이 URL→텍스트 |
| `filesystem` | Personal 디렉토리 파일 접근 |

### Chrome CDP 실행 (탭 자동화 필요 시)

단순히 Chrome을 여는 것은 `macos-automator`만으로 충분합니다. 탭 안에서 클릭·입력·스크래핑이 필요할 때만 아래를 실행합니다.

```bash
./scripts/start-chrome-debug.sh
```

Chrome이 `--remote-debugging-port=9222`로 실행되면 `chrome-devtools` MCP가 연결됩니다.

### macOS 권한 (TCC)

Hermes(또는 Hermes를 실행하는 Node/npx)에 아래 권한을 부여한 뒤 **앱을 완전히 재시작**하세요.

| 권한 | 필요 MCP | 설정 위치 |
|------|----------|-----------|
| Automation | macos-automator | 시스템 설정 → 개인정보 보호 → Automation |
| Accessibility | macos-automator, chrome-devtools | 접근성 |
| Screen Recording | chrome-devtools (스크린샷 시) | 화면 녹화 |
| Files and Folders | filesystem | 파일 및 폴더 |

### Hermes 채팅 테스트 예시

1. `Chrome 열어줘` → macos-automator
2. `google.com 열어줘` → macos-automator 또는 shell
3. `현재 탭 제목 알려줘` → chrome-devtools (9222 CDP 필요)

### 보안 주의

- `shell` MCP는 호스트에서 임의 명령을 실행할 수 있습니다. 로컬 전용·신뢰된 모델만 사용하세요.

## 8) 체크 스크립트

비파괴 검증은 아래 스크립트로 실행합니다.

```bash
node scripts/check-hermes-local.mjs
```

기본 동작:

- `mcp/servers`와 `mcp/enabled`의 JSON 형식 및 활성 링크 검증
- Chrome CDP(9222) 응답 여부 INFO 출력 (미응답 시 FAIL 아님)
- Proxy 건강 상태(`/api/health`) 확인
- `MODEL_PATH` 존재 여부 확인
- `http://127.0.0.1:8080/v1/chat/completions`에 샘플 프롬프트 전송
- 응답이 `READY` 계열이면 성공으로 판정

필요하면 아래 환경변수로 바꿀 수 있습니다.

```bash
HERMES_BASE_URL=http://127.0.0.1:8080 \
HERMES_MODEL_ID=gemma-4-E4B-it-Q5_K_M.gguf \
MODEL_PATH=/Users/robertlee/Workspace/Personal/localclaw/model/gemma-4-E4B-it-Q5_K_M.gguf \
node scripts/check-hermes-local.mjs
```

## 9) 빠른 점검

1. llama.cpp 서버 실행 후 `localhost:8080`에서 응답 확인
2. Hermes에서 해당 모델 선택 후 단문/다중턴 질문 테스트
3. Chrome 탭 자동화가 필요하면 `./scripts/start-chrome-debug.sh` 실행
4. MCP 추가/활성화 후 Hermes 재시작하여 인식 확인
5. macOS TCC 권한 부여 후 Chrome/앱 제어 테스트

## 10) GitHub Pages

배포 흐름은 다음과 같습니다.

1. `npm install`
2. `npm run build`
3. `npm run deploy:pages`

`deploy:pages`는 `gh-pages` 브랜치에 정적 파일을 게시하고, Pages 설정이 없으면 `gh api`로 초기화합니다.

`VITE_PROXY_URL` 또는 `OPENHERMES_PROXY_URL`을 설정하면 Pages 빌드에 그 URL이 기본값으로 들어갑니다.
`OPENHERMES_API_TOKEN` / `OPENHERMES_API_SECRET`을 설정하면 `chat`, `control`, `permissions`, `automate`, `audit`, `requests` 같은 보호된 엔드포인트가 서명 검증을 요구합니다. 로컬 루프백에서는 편의를 위해 무서명 허용이 남아 있습니다.

외부 채널 승인 흐름:

1. Slack, Discord, GitHub webhook, 또는 Pages UI에서 요청을 보냅니다.
2. `POST /api/requests` 또는 `POST /api/control`은 기본적으로 즉시 실행됩니다.
3. UI의 `최근 요청`에서 실행 결과와 감사 기록을 확인합니다.
4. 요청이 들어오면 Hermes가 macOS 자동화를 실행하고 결과가 감사 로그에 남습니다.

웹 UI의 `Computer Use` 패널은 실제 프롬프트 창입니다. 예를 들어 `Chrome으로 daum.net 열어줘`를 넣고 실행하면, Hermes가 계획을 만들고 macOS 자동화가 실제로 실행됩니다.
최근에는 실행 뒤에 `frontmost app`, `window title`, `screen OCR`, `terminal output visible`, `shell verify`를 다시 확인하는 루프를 넣어서, 실패 시에는 재계획을 한 번 더 시도하도록 개선했습니다.

Zed 시나리오는 `+` 버튼을 먼저 누르고, `ls -la` 같은 명령을 터미널에 넣은 다음, 화면 OCR과 터미널 출력 가시성 검증, 셸 검증으로 결과를 확인하는 흐름을 기본으로 사용합니다.

주의:

- 공개 GitHub Pages는 `OPENHERMES_PROXY_URL`에 들어간 Funnel URL을 호출해야 정상 동작합니다.
- 외부 요청은 기본적으로 즉시 실행됩니다. 승인 대기 정책이 필요하면 `OPENHERMES_APPROVAL_MODE=required`로 바꿀 수 있습니다.
- Slack/Discord/GitHub webhook은 각각 `OPENHERMES_SLACK_WEBHOOK_SECRET`, `OPENHERMES_DISCORD_WEBHOOK_SECRET`, `OPENHERMES_GITHUB_WEBHOOK_SECRET`로 보호할 수 있습니다.

## 11) 범위

- 포함: 모델 연결 + Tools 활성화 + MCP 확장 구조
- 제외: Telegram/스케줄러(필요 시 후속 확장)
