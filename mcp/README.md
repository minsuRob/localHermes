# MCP 운영 가이드

이 디렉토리는 MCP 서버를 파일 기반으로 독립 관리하기 위한 표준 구조입니다.

## 디렉토리 구조

- `servers/`: MCP 서버 원본 정의 파일
- `enabled/`: Hermes가 로드할 활성 MCP 목록
- `templates/`: 새 MCP를 만들 때 복사할 템플릿

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
ln -s ../servers/filesystem.json enabled/filesystem.json
```

## 비활성화 절차

- `enabled/`에서 대상 파일(또는 링크) 제거
- 또는 `servers/<name>.json` 내 `disabled: true` 설정 후 운영 정책에 따라 반영

## 보안 원칙

- 토큰/시크릿은 JSON에 하드코딩하지 않습니다.
- `env`에는 `$GITHUB_TOKEN` 같은 환경변수 참조만 기록합니다.
- 민감값은 `.env` 또는 OS Keychain에서 주입합니다.

## 검증 체크리스트

- [ ] `command`가 로컬에서 실행 가능
- [ ] `args`와 `cwd`가 올바른 경로 사용
- [ ] `env`의 변수명이 실제로 설정됨
- [ ] `enabled/` 등록 후 Hermes 재시작 시 MCP가 로드됨
- [ ] 비활성화 시 로딩에서 제외됨
