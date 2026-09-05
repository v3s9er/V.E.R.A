# Mr.Robot 0.4.1

0.4.1은 플러그인을 찾는 화면에서 바로 안전하게 작업할 수 있도록 카탈로그, 전용 작업 화면, 저트래픽 보안 도구를 하나의 흐름으로 묶은 릴리스입니다.

## 가장 먼저 적용한 저장소 보호

- GitHub 저장소 설정에서 **Secret scanning**을 활성화했습니다.
- 같은 설정에서 **Push protection**도 활성화했습니다.
- 따라서 저장소 이력의 알려진 비밀 패턴 탐지와 새 push 단계의 차단을 함께 사용합니다. 이 보호는 앱의 DPAPI 저장, 로그 마스킹, 공개 릴리스 감사와 별개로 동작하는 추가 방어선입니다.

## 플러그인 카탈로그와 작업 화면

- 플러그인을 `시스템·연결`, `생산성`, `개발`, `모의해킹`, `기타` 카테고리로 묶어 개수와 함께 표시합니다.
- 관리자는 카테고리를 바꿀 수 있으며 선택은 호스트 설정에 유지됩니다. 기존 외부 플러그인은 기본 `기타`, 분류가 없는 기본 플러그인은 안전한 내장 기본값을 사용합니다.
- 플러그인 카드의 `작업 화면`에서 입력, 사전 점검, 승인, 진행률, 요약 결과와 원본 JSON을 확인할 수 있습니다.
- Resource Archiver와 SSL/TLS Inspector에는 전용 UI가 있으며, 다른 기본 플러그인은 검토된 읽기 전용 명령만 바로 실행합니다. 외부 플러그인의 임의 명령은 UI가 자동 실행하지 않습니다.

## Authorized Web Resource Archiver

공개 기능 설명만을 비교 기준으로 삼아 새로 구현한 Mr.Robot 기본 플러그인입니다. Chrome 확장 프로그램의 소스 코드를 열람·복사·번들하지 않았습니다.

- 직접 URL, 제공된 브라우저/CDP 응답 본문, HAR 1.2 형태 입력을 조합할 수 있습니다.
- 이미 받은 본문을 먼저 쓰며 `fetchMissing: true` 전에는 네트워크를 사용하지 않습니다. 작업 화면의 권장 HAR 모드는 요청 0회입니다.
- HTML/CSS 의존성 그래프, 저장된 자원에 대한 로컬 링크 재작성, SHA-256 무결성 manifest와 checksum, 동일 본문 중복 제거, 부분 실패 기록을 ZIP에 담습니다.
- 작업 화면의 직접 수집 기본값은 깊이 1, 동시 요청 2개, 재시도 0회이며 리디렉션을 포함한 물리 HTTP GET을 최대 40회로 강제합니다. 엔진의 절대 GET 상한은 500회이고 전체 실행은 기본 60초·최대 300초로 제한됩니다. 자원 수·개별/전체 해제 바이트·요청 간격·개별 timeout에도 별도 상한이 있습니다.
- HTTP(S) GET만 사용하고 쿠키·Authorization·Referer·임의 헤더를 받지 않습니다. 정확한 교차 출처 allowlist, 공개 DNS 검증과 주소 고정, redirect 재검증, 민감 query 값 마스킹, 작업 폴더 밖 경로와 덮어쓰기 차단을 적용합니다.
- 대상 소유 또는 보존 허가 확인, 실행별 승인, 선택된 작업 폴더가 모두 필요하며 한 번에 보존 작업 하나만 실행합니다.

## SSL/TLS Inspector

`sslscan`을 호출하거나 감싼 것이 아니라 Node/OpenSSL 위에 새로 만든 독립 검사기입니다. 공식 `sslscan` 소스는 복사하지 않았고 실행 파일도 앱에 포함하지 않습니다.

- 단일 공개 호스트와 제한된 직접 TLS 포트만 받으며 URL, CIDR, 파일, 다중 대상, 사설·특수 주소를 거부합니다.
- DNS A/AAAA 응답을 모두 정책 검사한 뒤 선택 주소를 연결에 고정합니다.
- 기본 `quick`은 TLS 1.0~1.3 핸드셰이크 4회와 인증서/협상 정보만 확인하며 개별 암호군 탐색은 0회입니다.
- `standard`와 `deep`은 사용자가 선택한 경우에만 각각 제한된 대표 암호군과 로컬 엔진이 제공하는 암호군을 상한 안에서 확인합니다. 동시 실행·호스트별 간격·소켓/전체 timeout·취소를 적용하고 동일 조건 결과는 기본 5분 캐시합니다.
- 구조화 JSON, 진행 이벤트, 인증서 체인, 명시적 `inconclusive` 결과와 정책 finding을 제공합니다. 취약점 exploit 패킷이나 HTTP 요청은 보내지 않습니다.

## 독립 구현과 비교 검증

허가된 로컬 임시 TLS fixture에서 공식 `sslscan` 2.2.2와 결과를 비교했습니다. 두 구현 모두 TLS 1.2/1.3, `CN=localhost`, `TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256`, `TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384`를 일치하게 확인했습니다. 같은 fixture의 TCP 연결 수는 공식 도구 80회, Mr.Robot `quick` 4회, `deep` 31회였습니다. 이 수치는 해당 fixture와 실행 옵션에 한정된 트래픽 근거이지 모든 서버에서의 성능 보장은 아닙니다.

공식 2.2.2 Windows 실행 파일은 저장소 밖 임시 비교 환경에서 결과 대조에만 사용했습니다. 런타임·빌드 의존성이나 배포물에 포함하지 않았으며 어떠한 소스 코드도 가져오지 않았습니다. 자세한 범위와 한계는 [PLUGIN_COMPARISON_0.4.1.md](PLUGIN_COMPARISON_0.4.1.md)를 보세요.

## 알려진 범위

- Resource Archiver는 저장된 HTML/CSS 링크를 재작성하지만 임의 JavaScript 애플리케이션이 완전한 오프라인 사이트로 동작한다고 보장하지 않습니다. 현재 작업 화면은 HAR JSON 붙여넣기와 제한된 직접 수집을 제공하며 Chrome 탭 자동 캡처 확장 프로그램은 포함하지 않습니다.
- SSL/TLS Inspector는 SSLv2/SSLv3, STARTTLS/RDP/DB 프로토콜 준비 과정, TLS 1.3 암호군 전체 열거, Heartbleed·fallback SCSV·재협상·압축 능동 검사를 구현하지 않습니다. 이 범위가 필요하면 공식 `sslscan` 같은 전용 도구를 별도 승인 환경에서 사용하세요.

## 설치 파일

- Windows x64 빌드 결과: `Mr.Robot-Setup-0.4.1-x64.exe`
- 공개 소스 아카이브: `Mr.Robot-source-0.4.1.zip`
- 두 파일의 SHA-256 목록: `SHA256SUMS-0.4.1.txt`
- Android는 이번 릴리스에서 변경하지 않았으며 계속 `Mr.Robot-Mobile-0.4.0.apk` (versionCode 15)를 사용합니다.

Windows 설치본은 Authenticode로 서명되지 않아 SmartScreen이 표시될 수 있습니다. GitHub 릴리스에 함께 배포한 `SHA256SUMS-0.4.1.txt`로 반드시 파일 해시를 확인하세요.

## 근거 문서

- [Save All Resources — Chrome Web Store](https://chromewebstore.google.com/detail/save-all-resources/abpdnfjocnmdomablahdcfnoggeeiedb)
- [Chrome Extensions `devtools.network`](https://developer.chrome.com/docs/extensions/reference/api/devtools/network)
- [Chrome Extensions `debugger`](https://developer.chrome.com/docs/extensions/reference/api/debugger)
- [Chrome DevTools Protocol — Network](https://chromedevtools.github.io/devtools-protocol/tot/Network/)
- [Chrome DevTools Protocol — Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/)
- [rbsec/sslscan README](https://github.com/rbsec/sslscan/blob/master/README.md)
- [rbsec/sslscan releases](https://github.com/rbsec/sslscan/releases)
