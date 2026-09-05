# Mr.Robot 0.4.2 플러그인 비교와 독립 구현 근거

이 문서는 0.4.1의 Resource Archiver·SSL/TLS Inspector 비교를 유지하면서 0.4.2의 WebCrypto Runtime Observer와 독립 도구 포털 범위를 추가합니다. 공개 제품 설명과 공식 API 문서는 기능·평가 기준으로만 사용했습니다. 외부 확장 프로그램이나 `sslscan`의 소스·바이너리를 Mr.Robot 구현에 복사, 변형 또는 번들하지 않았습니다.

## 1. WebCrypto Runtime Observer

이 도구는 webhook 등록기가 아니라 허가된 페이지의 **클라이언트 암호화 런타임 경계 관찰기**입니다. Web Crypto API에서 `encrypt()`는 `BufferSource` 입력을 받고 `decrypt()`는 평문 결과를 비동기로 반환하므로, 페이지 코드보다 먼저 설치한 제한형 wrapper에서 두 경계를 관찰할 수 있습니다. 초기 스크립트 주입과 로컬 이벤트 전달은 Chrome DevTools Protocol의 공개 `Page.addScriptToEvaluateOnNewDocument`와 `Runtime.addBinding` 계약 위에 독립 구현했습니다.

| 항목 | 일반 브라우저 디버깅/자동화 | Mr.Robot Runtime Observer |
| --- | --- | --- |
| 대상 입력 | 사용자가 탭·스크립트를 수동 탐색 | 정확한 허용목록 URL, 최대 256 KiB JS 붙여넣기, 또는 기본 WebCrypto 후보 안내 |
| 정적 후보 | DevTools 검색·별도 분석기 | 고정 토큰 패턴만 오프라인 검사; 코드 실행·import·source map 수집 없음 |
| 실행 브라우저 | 기존 프로필을 사용할 수 있음 | 설치된 Chrome/Edge의 무작위 임시 프로필; 사용자 쿠키·확장·동기화 없음 |
| 런타임 범위 | 임의 breakpoint/코드 실행 가능 | `SubtleCrypto.encrypt` 입력과 `decrypt` 완료 결과만 wrapper |
| 기본 데이터 | 개발자가 선택 | 메타데이터 전용; 평문은 별도 opt-in 때 최대 128바이트 |
| 변경 | 콘솔에서 반복 변경 가능 | 평문 미리보기 세션에서 실제 관찰된 잘리지 않은 동일 단계의 평문과 정확히 일치하는 UTF-8 literal만 다음 일치 1회, 다중 확인과 64바이트 상한 |
| 네트워크 | 페이지 본래 동작에 따름 | HTTPS 443 단일 origin, DNS 검증·고정, 10초/20요청 기본, cross-origin·source map·보조 채널 차단 |
| 위험한 HTTP | 페이지 본래 동작에 따름 | GET/HEAD/OPTIONS 기본, POST/PUT/PATCH 별도 확인, DELETE 항상 차단 |
| 보존 | 프로필/DevTools 설정에 남을 수 있음 | source·preview를 디스크나 브라우저 저장소에 저장하지 않는 메모리 링 |

의도적으로 DOM 입력, 키보드, 비밀번호 필드, 쿠키, local/session storage, CryptoKey를 수집하지 않습니다. CryptoJS·libsodium·WASM·사용자 정의 함수 전체를 후킹하는 범용 계측기도 아닙니다. 이 제한은 탐지 범위의 한계인 동시에 민감정보와 CPU 부하를 줄이는 보안 경계입니다.

## 2. 독립 도구 포털

세 URL은 동일한 정적 앱과 좁은 `/api/tool-portal` 명령 매핑을 사용하지만 인증 세션과 대상 정책은 서버가 소유합니다. 포털 어댑터도 외부 구현을 실행하지 않고 Mr.Robot의 독립 Resource/TLS/Runtime 엔진만 호출합니다. 브라우저는 Mr.Robot 관리자 secret, WebSocket 토큰, 작업 폴더 절대 경로, Cloudflare Service Token을 받지 않습니다.

| 경계 | 구현 |
| --- | --- |
| 기본 노출 | 초기값 OFF; 네이티브 앱에서 포털 전용 비밀번호를 처음 저장할 때만 활성화 |
| 공개 origin | loopback 또는 최근 검증된 정확한 Cloudflare Named Tunnel HTTPS origin |
| 비밀번호 저장 | 무작위 salt + 고정 비용 scrypt verifier만 로컬 저장; 원문 미저장 |
| 로그인 방어 | 비동기 KDF 동시성 제한, 클라이언트별/전역 실패 제한, 응답 캐시 금지 |
| 세션 | 서버 메모리, 고정 30분, 수량 제한, HttpOnly/SameSite Strict/HTTPS Secure 쿠키 + 포트별 sessionStorage 요청 증명; 둘을 모두 요구 |
| 요청 위조 | 정확한 Origin·Fetch Metadata·JSON content type 검사; 외부 form/frame 차단 |
| 도구 호출 | `(tool, action)` 고정 allowlist에서만 실제 플러그인 명령으로 변환 |
| 대상 | 와일드카드·접미사 매칭·포트·경로가 없는 네이티브의 정확한 IDNA DNS 허용목록을 Resource/TLS/Runtime에 공통 적용; 빈 목록은 능동 접속 거부 |
| 파일 | 서버 선택 workspace, 절대 경로 제거, session-bound 2분/1회용 capability, open-file 재검증 |
| 권한 폐기 | 설정 변경·비활성화·로그아웃 때 세션/작업/observer/capability 폐기 |

포털 비밀번호는 Cloudflare Access를 대체하지 않습니다. 외부 노출에서는 두 계층이 모두 성립해야 하고, Cloudflare 검증 상태가 오래되거나 tunnel 상태가 바뀌면 포털 origin 승인을 닫습니다.

## 3. Resource Archiver와 Save All Resources

전체 비교와 수치 근거는 [0.4.1 비교 문서](PLUGIN_COMPARISON_0.4.1.md#1-authorized-web-resource-archiver)를 따릅니다. 0.4.2는 엔진을 외부 확장으로 바꾸지 않고 포털 어댑터만 추가했습니다.

- 제공된 HAR/캡처 본문 우선, 직접 네트워크 기본 OFF 원칙을 유지합니다.
- 포털의 오프라인 사전 점검은 물리 요청 0회입니다. ZIP 보관의 직접 수집도 기본 동시성 1·재시도 0·요청 간 최소 300ms·물리 GET 20회 상한을 넘지 않으며, 서버가 허용하는 동시성의 절대 상한은 2입니다.
- ZIP은 서버가 선택한 workspace에만 생성하고, 브라우저에는 짧은 1회용 다운로드 capability만 제공합니다.
- Chrome 확장 프로그램의 소스나 실행 코드는 포함하지 않습니다.

## 4. SSL/TLS Inspector와 공식 sslscan

독립 엔진의 기능표와 허가된 fixture 비교는 [0.4.1 비교 문서](PLUGIN_COMPARISON_0.4.1.md#2-ssltls-inspector와-공식-sslscan-222)를 따릅니다. 당시 동일 fixture에서 두 도구 모두 TLS 1.2/1.3, 인증서 주체, 허용한 TLS 1.2 암호군 두 개를 일치하게 확인했고 TCP 연결은 공식 비교 실행 80회, Mr.Robot quick 4회, deep 31회였습니다. 이 수치는 해당 fixture·옵션에만 해당합니다.

0.4.2 포털은 `quick`을 기본으로 하고 `standard`도 대표 암호군 검사를 최대 12회만 허용합니다. 네 번의 프로토콜 점검을 합쳐 실제 TLS 연결은 최대 16회입니다. 단일 정확한 DNS 대상, 공개 주소 검증·고정, 제한 포트, timeout과 캐시 정책은 기존 독립 엔진이 다시 검증합니다. 공식 `sslscan`은 비교 oracle일 뿐 런타임·빌드 의존성이 아닙니다.

## 5. 사용 경계

- 모든 능동 기능은 소유하거나 명시적으로 허가받은 대상에서만 사용합니다.
- 체크박스와 포털 로그인은 법적·운영 허가를 대신하지 않습니다.
- Runtime Observer의 평문 출력은 최소화해도 비밀을 포함할 수 있습니다. 필요가 끝나면 세션을 즉시 중지하고 포털을 비활성화하세요.
- Resource Archiver는 인증 세션 복제나 우회 crawler가 아니며, SSL/TLS Inspector는 legacy/STARTTLS/능동 exploit을 포함한 공식 `sslscan` 전체 대체품이 아닙니다.
- 비교는 동작 범위와 회귀 기준을 설명하며 코드 동일성을 뜻하지 않습니다.
