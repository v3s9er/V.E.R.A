# Mr.Robot 0.4.2

0.4.2는 허가된 자체 웹 서비스의 클라이언트 암호화 경계를 진단하는 **WebCrypto Runtime Observer**와, 세 보안 도구를 각각 열 수 있는 비밀번호 보호형 독립 도구 포털을 추가한 릴리스입니다. 외부 구현의 소스 코드를 복사하거나 실행 파일을 번들하지 않았습니다.

## WebCrypto Runtime Observer

- `webcrypto-observer` 기본 플러그인을 `모의해킹` 카테고리에 추가했습니다.
- 사용자가 JavaScript를 붙여넣으면 최대 256 KiB 안에서 고정 토큰 패턴만 오프라인 분석합니다. 코드를 `eval`, `Function`, 동적 import로 실행하지 않고, 소스 본문도 저장하지 않습니다.
- 입력이 없을 때는 `crypto.subtle.encrypt()` 입력과 `crypto.subtle.decrypt()` 완료 결과를 기본 관찰 후보로 안내합니다. `TextEncoder`/`TextDecoder`는 오프라인 분석 후보일 뿐 런타임에서 광범위하게 감시하지 않습니다.
- 활성 관찰은 별도 임시 프로필의 설치된 Chrome/Edge를 사용합니다. 사용자의 기존 브라우저 프로필, 쿠키, 로그인 상태, 확장 프로그램을 가져오지 않습니다.
- 대상은 네이티브 관리자가 등록한 정확한 공개 DNS 이름의 HTTPS 443 URL 하나로 제한됩니다. 모든 DNS 답을 검사한 뒤 선택 주소를 브라우저에 고정하고, 다른 호스트는 이름 해석 단계에서 차단합니다.
- 기본 세션 프리셋은 10초, 물리 요청 20회, 이벤트 링 64개이며 플러그인 하드 상한도 각각 30초·40회·128개입니다. source map·재귀 탐색·다운로드·보조 브라우저 트래픽 채널을 차단하고, 동일 출처의 GET/HEAD/OPTIONS만 기본 허용하며 DELETE는 항상 차단합니다. 로컬 CDP도 수신 프레임 4,096개·누적 8 MiB·런타임 이벤트 512개·동시 대기 명령 64개에서 즉시 fail-closed합니다.
- 기본값은 알고리즘·단계·바이트 길이 같은 메타데이터 전용입니다. 평문은 세션별 별도 확인이 있을 때만 이벤트당 최대 128바이트를 메모리에서 미리 봅니다.
- 포털의 평문 변경은 네이티브 전역 opt-in, 평문 미리보기 세션, 실행별 `다음 literal 일치 1회` 승인을 모두 요구합니다. 같은 세션에서 실제 관찰된 잘리지 않은 동일 단계의 평문과 정확히 일치하는 UTF-8 literal(1~64바이트)만 등록할 수 있고, 규칙은 한 번 적용되면 폐기됩니다. 치환값은 최대 64바이트이며 정규식이나 코드는 허용하지 않습니다. POST/PUT/PATCH는 또 다른 상태 변경 확인이 있어야 하며 DELETE는 승인 여부와 무관하게 차단됩니다.

## 비밀번호 보호형 독립 도구 포털

다음 경로를 CyberChef처럼 개별 도구 화면으로 열 수 있습니다.

- `/tools/resource-archiver`
- `/tools/sslscan`
- `/tools/runtime-hook`

포털은 기본적으로 꺼져 있으며, 네이티브 데스크톱 앱의 `설정 → 도구 포털`에서 포털 전용 비밀번호를 처음 저장할 때만 활성화됩니다. 나머지 설정은 해당 기능을 실행할 때 적용됩니다.

- 관리자·기기 secret과 별개인 12바이트 이상의 포털 전용 비밀번호
- 세 도구가 능동 접속하기 전에 필요한, 와일드카드·접미사 매칭·포트·경로 없는 정확한 대상 DNS 허용목록
- Resource Archiver로 ZIP을 만들 때만 필요한 등록 작업 폴더
- 포털의 POST/PUT/PATCH와 런타임 literal 변경을 위한 선택적 전역 opt-in

비밀번호 원문은 저장하지 않고 무작위 salt가 있는 scrypt verifier만 로컬 설정에 보관합니다. 로그인 검증은 비동기·동시성 제한형이며 클라이언트별/전역 실패 제한을 함께 적용합니다. 성공 세션은 서버 메모리에만 있고 고정 30분 만료, 세션 수 상한, `HttpOnly`, `SameSite=Strict`, HTTPS의 `Secure` 쿠키를 사용합니다. 쿠키와 별도로 생성한 요청 증명은 서버에 해시만 두고 포털의 포트별 `sessionStorage`에 보관하므로, 같은 loopback 호스트의 다른 포트가 쿠키를 보더라도 단독으로 세션을 재사용할 수 없습니다. 설정을 바꾸거나 포털을 끄면 세션, 진행 작업, 런타임 관찰, 다운로드 권한을 모두 폐기합니다.

루프백 외부에서 포털을 노출하는 경로는 현재 실행 중인 **정확한 Cloudflare Named Tunnel HTTPS origin** 하나뿐입니다. Mr.Robot이 익명 차단과 Access 인증 경계를 확인한 상태에서만 허용하며 포털 비밀번호는 그 위의 추가 인증 계층입니다. Quick Tunnel, 일반 LAN HTTP, Tailscale 주소를 독립 포털 공개 경로로 승격하지 않습니다.

Resource Archiver 포털은 클라이언트가 파일 경로를 고르지 못합니다. 서버가 등록 작업 폴더 안에 충돌 없는 ZIP 이름을 만들고 절대 경로를 응답에서 제거한 뒤, 같은 로그인에 결합된 2분 만료·1회용 다운로드 권한만 돌려줍니다. 다운로드 직전에도 실제 경로, 파일 identity와 크기를 재검증합니다.

## 기존 도구와 의존성 보강

- Resource Archiver 포털 프리셋은 캡처/HAR 우선입니다. 오프라인 사전 점검은 물리 요청 0회이며, ZIP 보관의 직접 수집은 기본 동시성 1·재시도 0·물리 GET 최대 20회로 제한됩니다. 서버가 허용하는 동시성의 절대 상한도 2입니다.
- SSL/TLS Inspector는 기존 독립 구현과 `quick`/`standard` 저트래픽 모드를 그대로 사용하고, 포털 대상 허용목록을 한 번 더 적용합니다. `quick`은 프로토콜 연결 4회, `standard`는 대표 암호군 최대 12회를 더해 TLS 연결 총 최대 16회입니다.
- 새 런타임 의존성은 추가하지 않았습니다. 잠금 파일의 `fast-uri`, `qs`, `@xmldom/xmldom`을 보안 수정 버전으로 올렸습니다.

## 알려진 범위

- 런타임 관찰기는 WebCrypto의 `encrypt` 입력과 `decrypt` 결과에 집중합니다. 키 소재, 키보드 입력, DOM 전체, 저장소, 쿠키, source map을 수집하지 않습니다.
- 임의 라이브러리의 사용자 정의 암호화, 네이티브 코드, 난독화된 WASM 내부 처리를 자동으로 해석하지 않습니다. 붙여넣기 분석의 후보는 근거 있는 출발점이지 데이터 흐름 증명은 아닙니다.
- 별도 임시 브라우저는 기존 로그인 세션을 사용하지 않으므로 인증이 필요한 페이지는 테스트 전용 진입 경로를 마련해야 합니다.
- 평문 미리보기와 변경은 민감정보 노출·실제 서버 상태 변경 위험이 있습니다. 소유하거나 명시적으로 허가받은 테스트 환경에서만 사용해야 합니다.

## 설치 파일

- Windows x64: `Mr.Robot-Setup-0.4.2-x64.exe`
- 공개 소스: `Mr.Robot-source-0.4.2.zip`
- SHA-256 목록: `SHA256SUMS-0.4.2.txt`
- Android는 변경하지 않았으며 계속 `Mr.Robot-Mobile-0.4.0.apk` (versionCode 15)를 사용합니다.

Windows 설치본은 Authenticode로 서명되지 않아 SmartScreen이 표시될 수 있습니다. GitHub 릴리스의 SHA-256 목록과 비교하세요.

## 설계 근거

- [Chrome DevTools Protocol: Page.addScriptToEvaluateOnNewDocument](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-addScriptToEvaluateOnNewDocument)
- [Chrome DevTools Protocol: Runtime.addBinding](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-addBinding)
- [Chrome DevTools Protocol: Target.setAutoAttach](https://chromedevtools.github.io/devtools-protocol/tot/Target/#method-setAutoAttach)
- [MDN: SubtleCrypto](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto)
- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [Node.js crypto.scrypt](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback)
