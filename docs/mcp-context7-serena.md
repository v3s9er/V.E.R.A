# Context7 · Serena를 필요한 만큼 연결하기

Mr.Robot의 MCP 연결은 stdio 서버를 지원합니다. Context7은 라이브러리 문서 조회에, Serena는 프로젝트의 심볼과 참조 탐색에 사용할 수 있습니다. 아래 프리셋은 **미리보기만 생성**합니다. 설치, 서버 등록, 인증, 시작은 실행하지 않습니다. 사용자가 검토해 설치한 로컬 실행 경로를 지정한 뒤 관리자로 등록하고 활성화해야 합니다.

## 설정 미리보기와 등록

데스크톱의 **플러그인 → MCP Tool Connector → 설정·상세 → 설정 방식**에서 Context7, Serena, 직접 입력을 선택할 수 있습니다. 설치된 진입 파일과 Serena 프로젝트의 절대 경로를 입력한 뒤 **비활성으로 저장**하세요. 경로와 권한을 검토한 후 활성화 체크박스를 선택하고 다시 저장하면 사용할 수 있습니다. 서버를 자동 설치하지 않으며 API 키 입력칸은 없습니다. 보호된 환경 변수가 이미 있는 서버 ID는 이 폼으로 덮어쓰지 않습니다.

Context7은 Node.js가 필요합니다. 일반 Node 호스트에서는 해당 Node 실행 경로를 사용하고, 패키징된 Electron 앱에서는 PC의 PATH에 설치된 `node`를 사용합니다. Mr.Robot 앱 실행 파일을 Node 대신 실행하지 않습니다.

아래는 `plugins.call`에 전달할 `name`과 `params` 예시입니다. 프리셋 목록은 `mcp.presets.list`로 확인합니다.

Context7은 공식 배포판을 설치한 경로의 JavaScript 진입 파일을 지정합니다. 실제 설치 위치로 바꾸세요.

```json
{
  "name": "mcp.presets.preview",
  "params": {
    "preset": "context7",
    "executablePath": "C:\\MCP\\context7\\dist\\index.js"
  }
}
```

반환된 설정을 `mcp.servers.add`에 전달하면 비활성 상태로 저장할 수 있습니다. 인증이 필요하면 `env.CONTEXT7_API_KEY`에 자신의 키를 넣고, 연결 준비를 마친 뒤 `enabled: true`로 등록하세요. 환경 변수 값은 기존 Windows DPAPI 저장소에 암호화되며 목록에는 이름만 표시됩니다. 키를 `args`에 넣으면 프로세스 인자와 설정 목록에 나타날 수 있으므로 환경 변수를 사용하세요. 키를 대화나 저장소에 붙여 넣지 마세요.

Serena는 설치된 실행 파일과 사용할 프로젝트를 명시합니다.

```json
{
  "name": "mcp.presets.preview",
  "params": {
    "preset": "serena",
    "executablePath": "C:\\MCP\\serena.exe",
    "projectRoot": "C:\\Projects\\my-project"
  }
}
```

Serena 프리셋은 `--context ide`로 기본 코드 도구와의 중복을 줄이고, `--project`와 `cwd`를 같은 프로젝트로 설정합니다. 대시보드 자동 열기도 끕니다. Serena는 상태를 가진 서버이므로 프로젝트가 여러 개라면 반환된 `id`를 `serena-project-a`처럼 구분해 등록하세요. 프로젝트 경로 지정은 OS 수준의 샌드박스가 아니며, 서버 프로세스는 실행 계정의 권한으로 동작합니다.

`mcp.servers.add`는 관리자 명령입니다. `enabled: true`로 등록해도 즉시 실행하지 않으며 실제 도구 탐색 또는 호출 때 연결합니다. `mcp.servers.remove`는 연결과 관련 캐시를 정리합니다. 이 기능은 원격 HTTP MCP나 OAuth 흐름을 추가하지 않습니다.

## 모델이 사용하는 흐름

1. `mcp.discover {}`: 활성 서버의 ID와 이름을 최대 12개 반환합니다. 실행 명령, 인자, 환경 변수는 모델에 보내지 않습니다.
2. `mcp.discover {"serverId":"serena"}`: 도구 이름과 최대 240자의 설명만 반환합니다. `limit`은 1~20이며 `nextCursor`가 있으면 이어서 조회합니다.
3. `mcp.discover {"serverId":"serena","tool":"find_symbol"}`: 선택한 도구의 실제 `inputSchema`만 반환합니다. 후속 페이지에서 찾은 도구에는 **그 페이지를 읽을 때 사용한 cursor**를 함께 전달하세요. schema를 추측하지 마세요.
4. `mcp.call {"serverId":"serena","tool":"find_symbol","arguments":{...}}`: 확인한 schema에 맞춰 호출합니다.

탐색과 호출 도구는 MCP·Context7·Serena 또는 코드·라이브러리·문서 관련 요청일 때만 모델에 노출됩니다. 탐색은 서버 프로세스를 시작할 수 있으므로 호출과 마찬가지로 기존 승인 경계를 적용합니다. 외부 서버의 설명, schema, 결과는 지시가 아닌 신뢰되지 않은 데이터로 취급합니다. 서버가 주장하는 read-only 표시는 승인 규칙을 변경하지 않습니다.

Context7은 알려진 라이브러리 ID가 있으면 재검색을 줄일 수 있습니다. 라이브러리·버전과 질문 하나를 명시하고, 비공개 코드나 비밀 정보를 외부 문서 쿼리에 넣지 마세요. Serena는 파일 전체보다 심볼 이름과 경로를 먼저 확인하고, 필요한 심볼만 본문을 요청하면 출력이 줄어듭니다. 도구 이름과 옵션은 서버 버전에 따라 달라질 수 있으므로 실제 schema를 조회하세요.

## 출력과 캐시 한계

- 도구 목록은 상류 서버의 페이지와 Mr.Robot의 12개 기본 페이지를 모두 따릅니다. 전체 schema를 프롬프트에 일괄 삽입하지 않습니다.
- 목록 캐시는 60초, 총 200만 문자·최대 32페이지입니다. 한 페이지 100만 문자·2000개 도구와 개별 schema 24000자 한도를 넘으면 명시적 오류로 반환합니다. schema를 잘라 유효한 schema처럼 전달하지 않습니다.
- `mcp.call` 결과는 JSON 직렬화 기준 기본 12000자입니다. `maxResultChars`로 1000~32000자 범위에서 정할 수 있습니다. 이 값은 토큰 수가 아닙니다.
- 큰 결과는 `content`에 JSON의 앞부분을 담고 `_mrRobot.truncated: true`, 원래 문자 수와 안내를 반환합니다. 이 앞부분은 완전한 JSON이 아닙니다. 작은 응답은 기존 MCP 형태를 유지합니다.
- 잘린 원본을 별도로 저장하지 않습니다. 읽기 쿼리를 좁혀 필요한 부분을 다시 조회하세요. 출력 복구만을 위해 파일 변경 등 상태를 바꾸는 도구를 재실행하지 마세요.
- 인자 객체는 64000자까지 허용합니다. 연결·목록 조회는 30초, 도구 호출은 60초 제한이며 실행 취소 신호를 MCP SDK에 전달합니다. 실제 취소 동작은 서버의 지원 여부에도 달려 있습니다.
- 기존 `mcp.tools.list` RPC는 관리용 호환성을 위해 첫 상류 페이지의 전체 schema 배열을 그대로 반환합니다. 모델에는 노출하지 않으며 모델 작업에는 `mcp.discover`를 사용합니다.

## 확인한 공식 자료

2026-09-23 기준 설정을 확인했습니다. 설치한 버전의 `--help`와 비교하세요.

- [Context7 개발자 가이드](https://context7.com/docs/resources/developer)
- [Context7 공식 소스: stdio 및 CONTEXT7_API_KEY 지원](https://github.com/upstash/context7/blob/master/packages/mcp/src/index.ts)
- [Serena 실행 가이드](https://oraios.github.io/serena/02-usage/020_running.html)
- [Serena 클라이언트 가이드: 일반 코딩 클라이언트의 ide context](https://oraios.github.io/serena/02-usage/030_clients.html)

집중 검증: `node --import tsx --test packages/agent/test/mcp-efficiency.test.ts`. 테스트는 메모리 저장소와 가짜 MCP 클라이언트를 사용하므로 사용자 설정이나 실제 외부 서버에 접근하지 않습니다.
