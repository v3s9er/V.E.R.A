# Mr.Robot 0.4.1 플러그인 비교와 독립 구현 근거

이 문서는 0.4.1의 **Authorized Web Resource Archiver**와 **SSL/TLS Inspector**가 무엇을 새로 구현했고 어디까지 의도적으로 제한하는지 기록합니다. 비교 대상의 공개 설명과 공식 문서에서 기능·평가 기준만 확인했으며, 외부 프로젝트나 Chrome 확장 프로그램의 소스 코드를 복사·번들·변형하지 않았습니다.

## 1. Authorized Web Resource Archiver

비교 기준은 [Save All Resources의 Chrome Web Store 공개 설명](https://chromewebstore.google.com/detail/save-all-resources/abpdnfjocnmdomablahdcfnoggeeiedb)입니다. 해당 설명은 브라우저가 로드한 리소스를 폴더 구조를 유지한 ZIP으로 모으고 cache 재사용, XHR 본문, 목록·timeout, 선택적 beautify를 지원한다고 밝히며, 완전한 오프라인 웹사이트 다운로더는 아니라고 경계를 명시합니다. 이 표는 공개 동작 설명과 Mr.Robot 구현의 차이이며 확장 프로그램 소스 감사 결과가 아닙니다.

| 항목 | Save All Resources 공개 설명 | Mr.Robot Resource Archiver |
| --- | --- | --- |
| 실행 위치 | Chrome DevTools 확장 프로그램 | Mr.Robot 기본 플러그인과 플러그인 작업 화면 |
| 입력 | 현재 DevTools 페이지에서 로드된 리소스 | 직접 URL, 제공된 browser/CDP 응답 본문, HAR 1.2 형태 입력 |
| 이미 받은 본문 | browser cache와 XHR 본문 활용 | 제공된 캡처/HAR 본문을 항상 우선 사용; HAR 모드는 네트워크 0회 가능 |
| 추가 네트워크 | cache miss 재요청과 timeout 옵션 | 기본 OFF; `fetchMissing: true`에서만 같은 호스트/정확한 공개 allowlist를 GET |
| 결과 | 폴더 구조를 유지한 ZIP, 선택적 beautify | ZIP, URL→로컬 경로 manifest, SHA-256 checksum, 의존성 graph, 실패·시도 기록 |
| 오프라인 처리 | 공개 설명상 완전한 website downloader가 아님 | 저장된 HTML/CSS 참조만 로컬 경로로 재작성; JS 앱의 완전 실행은 보장하지 않음 |
| 의존성 탐색 | DevTools가 관찰한 리소스 중심 | HTML/CSS 참조를 깊이·개수·총량 상한 안에서 재귀 탐색 |
| 중복 처리 | 공개 설명에 내용 hash 중복 제거 언급 없음 | SHA-256이 같은 binary body는 한 번만 저장하고 manifest에서 참조 |
| 실패 처리 | download list와 timeout | 자원별 부분 실패를 보존하고 성공 자원 ZIP을 생성 |
| 트래픽 기본값 | 공개 설명에서 전역 저트래픽 정책은 확인되지 않음 | 캡처 우선, 직접 fetch OFF, UI 직접 모드 재시도 0·동시 2·깊이 1·물리 GET 최대 40회 |
| 권한·SSRF 경계 | Chrome 확장 권한과 현재 탭 맥락 | 실행별 허가 확인/승인, 공개 DNS 전부 검증, 주소 고정, redirect 재검증, 사설·특수 주소 차단 |
| 자격증명 | browser session 맥락 | Cookie·Authorization·Referer·proxy·임의 request header를 입력받거나 replay하지 않음 |
| 파일 안전 | 공개 설명에 host 작업 폴더 정책 없음 | 선택된 작업 폴더 아래만, traversal/Windows 장치명 정리, 기존 파일 overwrite 금지 |

엔진의 보수적 기본 상한은 자원 200개, 리디렉션·재시도를 포함한 물리 GET 40회, 깊이 2, 동시 요청 2개, 응답당 8 MiB, 전체 해제 본문 32 MiB, 요청 시작 간 최소 150 ms, 재시도 0회, 전체 실행 60초입니다. 작업 화면의 HAR 프리셋은 물리 GET 상한을 0회로 고정하고, 직접 수집 프리셋은 깊이 1에서 20·40·80회 중 선택하며 40회를 권장 기본값으로 사용합니다. 사용자가 API에서 상한을 올려도 물리 GET 500회·전체 실행 300초의 절대 범위와 단일 동시 archive gate를 넘을 수 없습니다.

Chrome 연동 설계의 공개 API 기준은 [Extensions `devtools.network`](https://developer.chrome.com/docs/extensions/reference/api/devtools/network), [Extensions `debugger`](https://developer.chrome.com/docs/extensions/reference/api/debugger), [Chrome DevTools Protocol Network](https://chromedevtools.github.io/devtools-protocol/tot/Network/), [Chrome DevTools Protocol Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/)입니다. 0.4.1은 이 API의 소스나 확장 프로그램을 포함하지 않으며, 작업 화면에서는 HAR JSON 입력 또는 제한된 직접 수집을 사용합니다.

## 2. SSL/TLS Inspector와 공식 sslscan 2.2.2

공식 비교 기준은 [rbsec/sslscan README](https://github.com/rbsec/sslscan/blob/master/README.md)와 [공식 릴리스](https://github.com/rbsec/sslscan/releases)입니다. Mr.Robot 검사기는 `sslscan` 프로세스를 호출하거나 라이브러리로 연결하지 않고 Node/OpenSSL의 공개 TLS API 위에 독립적으로 구현했습니다.

| 항목 | 공식 sslscan 2.2.2 | Mr.Robot SSL/TLS Inspector |
| --- | --- | --- |
| 주 용도 | 폭넓은 TLS/legacy SSL CLI 검사 | 앱 안에서 승인 후 실행하는 단일 대상 저트래픽 진단 |
| 프로토콜 | SSLv2, SSLv3, TLS 1.0~1.3 점검 | TLS 1.0~1.3; 로컬 엔진이 제공하지 못하면 `inconclusive`로 표시, SSLv2/3 제외 |
| 암호군 | 지원 암호군을 폭넓게 열거 | `quick` 0회, `standard` 기본 16/최대 24회, `deep` 최대 96회로 제한 |
| 인증서 | 인증서·chain과 관련 정보 | leaf/제한 chain, 이름·기간·self-signed·system trust·fingerprint를 구조화 |
| 추가 점검 | groups/signatures, compression, Heartbleed, fallback, renegotiation 등 | exploit 지향 probe를 보내지 않음; 협상 증거와 정책 finding에 집중 |
| 비직접 TLS | 여러 STARTTLS와 RDP/DB preamble 지원 | 직접 TLS만; STARTTLS/RDP/MySQL/PostgreSQL 준비 과정 제외 |
| 출력·통합 | 터미널과 XML 출력 | versioned JSON, 진행 event, 취소, 결과 UI, 5분 cache |
| 대상 범위 | 범용 CLI 입력 | 실행마다 허가된 호스트 1개와 allowlist 포트 1개; URL/CIDR/list 거부 |
| 네트워크 안전 | CLI 옵션으로 timeout/검사 범위 조정 | quick 4연결, active scan 동시 1개, deep cipher 동시 최대 2개, target 간격·timeout 상한 |
| SSRF/DNS 경계 | 범용 네트워크 검사 도구 | 모든 A/AAAA가 공개 주소인지 확인하고 실제 socket을 선택 주소에 고정 |

### 허가된 로컬 fixture 비교

2026-09-02 KST에 임시 `CN=localhost` 인증서로 TLS 1.2/1.3과 TLS 1.2 cipher 두 개만 허용하는 loopback fixture를 만들었습니다. loopback 허용은 테스트에서 직접 만든 scanner에만 켰고 배포 플러그인의 기본 정책은 바꾸지 않았습니다. 공식 도구에서는 이 비교에 불필요한 exploit·부가 enumeration 옵션을 껐습니다.

| 관찰값 | 공식 sslscan 2.2.2 | Mr.Robot | 판정 |
| --- | --- | --- | --- |
| 지원 TLS | TLS 1.2, TLS 1.3 | TLS 1.2, TLS 1.3 | 일치 |
| 인증서 주체 | `/CN=localhost` | `CN=localhost` | 표현 차이만 있고 일치 |
| TLS 1.2 cipher | `TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256`, `TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384` | 같은 두 IANA 이름 | 일치 |
| TCP 연결 수 | 80 | `quick` 4, `deep` 31 | 이 fixture에서 quick은 95% 적음 |

연결 수는 로컬 서버에서 각 실행을 분리해 센 값입니다. 서버 구성, 로컬 OpenSSL, 공식 도구 옵션과 cipher 수에 따라 달라지므로 보편적인 속도·부하 수치로 일반화하면 안 됩니다. Mr.Robot의 동일 조건 5분 cache hit는 새 TLS/TCP 연결을 만들지 않지만 DNS는 다시 확인하고 정책을 적용합니다.

공식 `sslscan` 2.2.2 Windows 실행 파일은 저장소 밖 임시 benchmark 디렉터리에서 비교 oracle로만 실행했습니다. 해당 실행 파일은 Mr.Robot에 번들되지 않고 npm/runtime/build 의존성도 아니며, 공식 프로젝트의 소스 코드는 열람해 옮기거나 복사하지 않았습니다.

## 3. 실전 사용 경계

- 두 플러그인은 **소유하거나 명시적으로 허가받은 대상**에서만 사용합니다. 체크박스와 실행 승인은 허가 자체를 만들어 주지 않습니다.
- 기본값은 범위를 넓히지 않습니다. Resource Archiver는 HAR/캡처 우선, SSL/TLS Inspector는 단일 대상 `quick` 우선입니다.
- Resource Archiver는 브라우저 자동화·인증 세션 복제·crawler 우회 도구가 아닙니다.
- SSL/TLS Inspector는 공식 `sslscan`의 전체 대체품이 아닙니다. legacy SSL, STARTTLS 또는 능동 취약점 검사가 필요하면 승인된 격리 환경에서 목적에 맞는 전용 도구를 사용합니다.
- 비교 결과는 기능 정확성과 트래픽 경계를 확인하는 회귀 기준이며 외부 구현과의 코드 동일성을 뜻하지 않습니다.
