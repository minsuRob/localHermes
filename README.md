# Hermes Local Setup (llama.cpp + Gemma + Extensible MCP)

이 저장소는 macOS 로컬 환경에서 `llama.cpp` + Gemma 모델로 Hermes Agent Desktop을 안정적으로 구동하고,
MCP 서버를 파일 기반으로 자유롭게 추가/활성화/비활성화할 수 있도록 표준 구조를 제공합니다.

## 1) 목표 구성

- Local LLM: `llama.cpp` 서버
- 모델: `gemma-4-E4B-it-Q5_K_M.gguf`
- 컨텍스트 길이: **70,000 이상**
- Hermes Base URL: `http://localhost:8080` (**`/v1` 붙이지 않음**)
- Hermes Tools: `Web Search`, `Browser`, `Terminal`, `File Operation` 활성화
- MCP: `mcp/servers` + `mcp/enabled` 기반 운영
- 활성 MCP: `filesystem`, `fetch`, `macos-automator`, `chrome-devtools`, `shell`

## 2) 모델 경로 환경변수

```bash
export MODEL_PATH=/Users/robertlee/Workspace/Personal/localclaw/model/gemma-4-E4B-it-Q5_K_M.gguf
```

원하면 셸 시작 파일(`~/.zshrc`)에 추가:

```bash
echo 'export MODEL_PATH=/Users/robertlee/Workspace/Personal/localclaw/model/gemma-4-E4B-it-Q5_K_M.gguf' >> ~/.zshrc
source ~/.zshrc
```

## 3) llama.cpp 서버 실행 표준

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

## 4) Hermes Agent Desktop 모델 연동

Hermes 앱에서 다음처럼 추가합니다.

1. `Models` 탭 → 새 모델 추가
2. `Provider`: `Local Provider`
3. `Base URL`: `http://localhost:8080` (중요: `/v1` 미포함)
4. `Model ID`: 실제 로드된 모델명 입력
5. `API Key`: 공란

## 5) Hermes Tools 활성화 체크리스트

`Tools` 탭에서 아래 항목을 모두 `ON`으로 변경합니다.

- `Web Search`
- `Browser`
- `Terminal`
- `File Operation`

## 6) MCP 운영 구조

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

## 6-1) Chrome 및 macOS 권한 MCP

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

## 7) 체크 스크립트

비파괴 검증은 아래 스크립트로 실행합니다.

```bash
node scripts/check-hermes-local.mjs
```

기본 동작:

- `mcp/servers`와 `mcp/enabled`의 JSON 형식 및 활성 링크 검증
- Chrome CDP(9222) 응답 여부 INFO 출력 (미응답 시 FAIL 아님)
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

## 8) 빠른 점검

1. llama.cpp 서버 실행 후 `localhost:8080`에서 응답 확인
2. Hermes에서 해당 모델 선택 후 단문/다중턴 질문 테스트
3. Chrome 탭 자동화가 필요하면 `./scripts/start-chrome-debug.sh` 실행
4. MCP 추가/활성화 후 Hermes 재시작하여 인식 확인
5. macOS TCC 권한 부여 후 Chrome/앱 제어 테스트

## 9) 범위

- 포함: 모델 연결 + Tools 활성화 + MCP 확장 구조
- 제외: Telegram/스케줄러(필요 시 후속 확장)
