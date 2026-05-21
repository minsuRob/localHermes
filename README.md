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
  - `sqlite`: 로컬 SQLite 조회용

자세한 사용법은 [`mcp/README.md`](./mcp/README.md)를 참고하세요.

## 7) 체크 스크립트

비파괴 검증은 아래 스크립트로 실행합니다.

```bash
node scripts/check-hermes-local.mjs
```

기본 동작:

- `mcp/servers`와 `mcp/enabled`의 JSON 형식 검증
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
3. 긴 대화에서 메모리 유지 확인
4. MCP 추가/활성화 후 Hermes 재시작하여 인식 확인

## 9) 범위

- 포함: 모델 연결 + Tools 활성화 + MCP 확장 구조
- 제외: Telegram/스케줄러(필요 시 후속 확장)
