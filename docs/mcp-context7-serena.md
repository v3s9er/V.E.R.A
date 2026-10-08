# Context7 · Serena를 필요한 만큼 연결하기

## 0.8.0 설치 도우미

`npm run setup:harness-tools -- --python "설치된 Python의 절대 경로" --install`은 에이전트 홈 아래 `tools/`에 Context7 4.2.0과 Serena 1.7.0, Serena 언어 서버에 필요한 uv 0.12.23을 별도 설치합니다. `--install`을 빼면 계획만 출력합니다. 전역 Python·다른 에이전트 설정·로그인 정보를 변경하거나 서버를 자동 활성화하지 않습니다. 각 상위 도구의 라이선스가 적용되며 VERA 배포 파일에는 포함하지 않습니다.

앱의 MCP 설정에서 프리셋을 고르고 **설치된 경로 불러오기**로 자동 입력한 뒤, Serena는 작업 프로젝트를 선택하여 저장하세요. Context7의 키는 더 높은 사용 한도를 위한 선택 사항이며 무인 인증이나 키 공유를 하지 않습니다. 선택한 Python 실행 파일의 형제 도구 폴더를 MCP 하위 프로세스 PATH에 추가하므로 venv 내부 uv/uvx를 찾을 수 있습니다. 전체 프로세스 PATH는 변경하지 않습니다.

`npm run test:harness-mcp-installed`는 개인 문서 대신 생성된 코드의 심볼과 공개 Node.js 문서 조회를 검사합니다. AI 모델을 호출하지 않으며 최초 언어 서버 준비에 다운로드가 발생할 수 있습니다.

V.E.R.A의 MCP 연결은 stdio 서버를 지원합니다. Context7은 라이브러리 문서 조회에, Serena는 프로젝트의 심볼과 참조 탐색에 사용할 수 있습니다. 아래 프리셋은 **미리보기만 생성**합니다. 설치, 서버 등록, 인증, 시작은 실행하지 않습니다. 사용자가 검토해 설치한 로컬 실행 경로를 지정한 뒤 관리자로 등록하고 활성화해야 합니다.

## 설정 미리보기와 등록

데스크톱의 **플러그인 → MCP Tool Connector → 설정·상세 → 설정 방식**에서 Context7, Serena, 직접 입력을 선택할 수 있습니다. 설치된 진입 파일과 Serena 프로젝트의 절대 경로를 입력한 뒤 **비활성으로 저장**하세요. 경로와 권한을 검토한 후 활성화 체크박스를 선택하고 다시 저장하면 사용할 수 있습니다. 서버를 자동 설치하지 않으며 API 키 입력칸은 없습니다. 보호된 환경 변수가 이미 있는 서버 ID는 이 폼으로 덮어쓰지 않습니다.

Context7은 Node.js가 필요합니다. 일반 Node 호스트에서는 해당 Node 실행 경로를 사용하고, 패키징된 Electron 앱에서는 PC의 PATH에 설치된 `node`를 사용합니다. V.E.R.A 앱 실행 파일을 Node 대신 실행하지 않습니다.

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
2. `mcp.discover {"serverId":"serena","query":"find symbol"}`: 선택한 서버의 이름·설명에서 키워드로 검색해 기본 상위 5개의 짧은 요약을 반환합니다. 모델 추가 호출 없이 최대 4개 상류 페이지를 조회합니다. `searchComplete: false`이면 같은 query와 최상위 `nextCursor`로 이어서 검색하세요. 의미 검색이나 전체 서버 자동 스캔이 아닙니다. query를 생략하면 기존 목록 조회(기본 12개)입니다. `limit`은 1~20입니다.
3. `mcp.discover {"serverId":"serena","tool":"find_symbol","cursor":"검색 결과 항목의 cursor"}`: 선택한 도구의 실제 `inputSchema`만 반환합니다. query는 생략하고 **선택한 검색 결과 항목 자체의 cursor**를 사용하세요. 목록 조회를 썼다면 그 페이지를 읽을 때 사용한 cursor를 전달합니다. 검색 계속용 최상위 nextCursor와 schema 조회용 항목 cursor는 다릅니다. schema를 추측하지 마세요.
4. `mcp.call {"serverId":"serena","tool":"find_symbol","arguments":{...}}`: 확인한 schema에 맞춰 호출합니다.

탐색과 호출 도구는 MCP·Context7·Serena 또는 코드·라이브러리·문서 관련 요청일 때만 모델에 노출됩니다. 탐색은 서버 프로세스를 시작할 수 있으므로 호출과 마찬가지로 기존 승인 경계를 적용합니다. 외부 서버의 설명, schema, 결과는 지시가 아닌 신뢰되지 않은 데이터로 취급합니다. 서버가 주장하는 read-only 표시는 승인 규칙을 변경하지 않습니다.

Context7은 알려진 라이브러리 ID가 있으면 재검색을 줄일 수 있습니다. 라이브러리·버전과 질문 하나를 명시하고, 비공개 코드나 비밀 정보를 외부 문서 쿼리에 넣지 마세요. Serena는 파일 전체보다 심볼 이름과 경로를 먼저 확인하고, 필요한 심볼만 본문을 요청하면 출력이 줄어듭니다. 도구 이름과 옵션은 서버 버전에 따라 달라질 수 있으므로 실제 schema를 조회하세요.

## 출력과 캐시 한계

- 도구 목록은 상류 서버의 페이지와 V.E.R.A의 12개 기본 페이지를 모두 따릅니다. 전체 schema를 프롬프트에 일괄 삽입하지 않습니다.
- 목록 캐시는 60초, 총 200만 문자·최대 32페이지입니다. 한 페이지 100만 문자·2000개 도구와 개별 schema 24000자 한도를 넘으면 명시적 오류로 반환합니다. schema를 잘라 유효한 schema처럼 전달하지 않습니다.
- `mcp.call` 결과는 JSON 직렬화 기준 기본 12000자입니다. `maxResultChars`로 1000~32000자 범위에서 정할 수 있습니다. 이 값은 토큰 수가 아닙니다.
- 큰 결과는 제한된 미리보기와 잘림 표시를 반환합니다. 미리보기는 완전한 JSON이라고 가정하면 안 됩니다. 작은 응답은 기존 MCP 형태를 유지합니다.
- 보관 한도 안의 큰 결과에는 `resultId`가 붙습니다. `mcp.result`의 `resultId`·`nextOffset`으로 같은 대화·권한에서 15분 동안 재실행 없이 이어 읽을 수 있습니다. 보관되지 않았거나 만료되었으면 읽기 쿼리를 좁히세요. 출력 복구만을 위해 상태를 바꾸는 도구를 재실행하지 마세요.
- 인자 객체는 64000자까지 허용합니다. 연결·목록 조회는 30초, 도구 호출은 60초 제한이며 실행 취소 신호를 MCP SDK에 전달합니다. 실제 취소 동작은 서버의 지원 여부에도 달려 있습니다.
- 기존 `mcp.tools.list` RPC는 관리용 호환성을 위해 첫 상류 페이지의 전체 schema 배열을 그대로 반환합니다. 모델에는 노출하지 않으며 모델 작업에는 `mcp.discover`를 사용합니다.

## 확인한 공식 자료

2026-09-23 기준 설정을 확인했습니다. 설치한 버전의 `--help`와 비교하세요.

- [Context7 개발자 가이드](https://context7.com/docs/resources/developer)
- [Context7 공식 소스: stdio 및 CONTEXT7_API_KEY 지원](https://github.com/upstash/context7/blob/master/packages/mcp/src/index.ts)
- [Serena 실행 가이드](https://oraios.github.io/serena/02-usage/020_running.html)
- [Serena 클라이언트 가이드: 일반 코딩 클라이언트의 ide context](https://oraios.github.io/serena/02-usage/030_clients.html)

집중 검증: `node --import tsx --test packages/agent/test/mcp-efficiency.test.ts`. 테스트는 메모리 저장소와 가짜 MCP 클라이언트를 사용하므로 사용자 설정이나 실제 외부 서버에 접근하지 않습니다.
