# MCP 운영 가이드

이 디렉토리는 MCP 서버를 파일 기반으로 독립 관리하기 위한 표준 구조입니다.

## 디렉토리 구조

- `servers/`: MCP 서버 원본 정의 파일
- `enabled/`: Hermes가 로드할 활성 MCP 목록
- `templates/`: 새 MCP를 만들 때 복사할 템플릿

## 활성 MCP 목록 (현재)

| 파일 | 패키지 | 역할 |
|------|--------|------|
| `filesystem.json` | `@modelcontextprotocol/server-filesystem` | Personal 디렉토리 파일 접근 |
| `fetch.json` | `mcp-fetch-server` | URL→텍스트 (JS 렌더링 없음) |
| `macos-automator.json` | `@steipete/macos-automator-mcp` | Chrome/앱 AppleScript 제어 |
| `chrome-devtools.json` | `chrome-devtools-mcp` | 실제 Chrome CDP 탭 자동화 |
| `shell.json` | `@mako10k/mcp-shell-server` | 터미널 명령 실행 (고위험) |

비활성 샘플: `sqlite.json`, `github.json` (`disabled: true`)

## Chrome 사용 흐름

1. **Chrome 앱 열기/종료/URL 열기** → `macos-automator` (CDP 불필요)
2. **탭 안 DOM 조작** → `./scripts/start-chrome-debug.sh` 실행 후 `chrome-devtools` 사용
3. **웹 페이지 텍스트만 필요** → `fetch` (브라우저 불필요)

## macOS 권한 (TCC)

Hermes가 MCP를 spawn할 때 사용하는 프로세스(Hermes 앱, Node, npx)에 권한을 부여해야 합니다.

| 권한 | MCP | 설정 |
|------|-----|------|
| Automation | macos-automator | 개인정보 보호 → Automation |
| Accessibility | macos-automator, chrome-devtools | 접근성 |
| Screen Recording | chrome-devtools | 화면 녹화 |
| Files and Folders | filesystem | 파일 및 폴더 |

권한 변경 후 Hermes를 완전히 재시작하세요.

## 설정 파일 스키마 (Config Contract)

각 MCP JSON은 다음 필드를 사용합니다.

- `name` (string): MCP 식별자
- `command` (string): 실행 바이너리
- `args` (array): 실행 인자 목록
- `env` (object): 환경변수 맵 (`$VAR_NAME` 형태로 참조 권장)
- `cwd` (string, optional): 실행 작업 경로
- `timeout` (number): 시작/응답 타임아웃(ms)
- `disabled` (boolean): 기본 비활성 여부

## 추가 절차

1. `templates/mcp.server.template.json`을 복사해 `servers/<name>.json` 생성
2. 값 채우기 (`command`, `args`, `env` 등)
3. 활성화:
   - 방법 A: `enabled/<name>.json`에 심볼릭 링크 생성(권장)
   - 방법 B: 원본 JSON을 복사
4. Hermes 재시작 후 MCP 인식 확인

예시(심볼릭 링크 방식):

```bash
ln -s ../servers/macos-automator.json enabled/macos-automator.json
```

## 비활성화 절차

- `enabled/`에서 대상 파일(또는 링크) 제거
- 또는 `servers/<name>.json` 내 `disabled: true` 설정 후 운영 정책에 따라 반영

## 보안 원칙

- 토큰/시크릿은 JSON에 하드코딩하지 않습니다.
- `env`에는 `$GITHUB_TOKEN` 같은 환경변수 참조만 기록합니다.
- 민감값은 `.env` 또는 OS Keychain에서 주입합니다.
- `shell` MCP는 호스트 전체 RCE에 해당합니다. 로컬 전용으로 사용하세요.
- npx `-y`는 패키지명 오타/탈취 위험이 있으므로, 운영 시 버전 pin을 검토하세요.

## 검증 체크리스트

- [ ] `command`가 로컬에서 실행 가능
- [ ] `args`와 `cwd`가 올바른 경로 사용
- [ ] `env`의 변수명이 실제로 설정됨
- [ ] `enabled/` 등록 후 Hermes 재시작 시 MCP가 로드됨
- [ ] Chrome 탭 자동화 시 `scripts/start-chrome-debug.sh` 실행 후 CDP(9222) 응답 확인
- [ ] macOS TCC 권한 부여 완료
- [ ] 비활성화 시 로딩에서 제외됨
