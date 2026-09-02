# Mr.Robot 0.4.0

0.4.0은 원격 연결의 보안 등록 흐름과 데스크톱·Android 사용성을 함께 강화한 릴리스입니다.

## 주요 변경

- Cloudflare Named Tunnel + Access를 이용한 VPN 없는 고정 원격 연결
- 12자리·10분·1회용 등록 코드와 최대 5분 서버 결합 assertion
- 장기 Access 자격증명을 QR·renderer·로그에서 제거
- 등록 assertion JSON 반사 제거, HttpOnly host cookie와 `cf-access-token` 재검증
- 재사용·만료·origin 불일치 등록 요청 차단
- Windows 원격 secret의 전용 DPAPI 영역과 구버전 안전 이관
- Android PC별 자격증명의 원자적 SecureStore bundle, 구형 저장 형식 이관 및 실패 롤백
- 다중 PC 선택·전환 안전성과 로컬 PC 단독 실행 개선
- 모바일 키보드·safe area·작은 화면 대응
- 데스크톱 좁은 창의 상단 컨트롤, 프로필/대화 메뉴, 프리셋·모델 선택, 모달 레이아웃 개선
- cloudflared 설치/자동 시작/중지 수명주기와 중복 상태 이벤트 개선
- 실제 DPAPI 및 Cloudflare Access secret 패턴을 포함한 공개 릴리스 감사 강화

## 설치 파일

- Windows x64: `Mr.Robot-Setup-0.4.0-x64.exe`
- Android: `Mr.Robot-Mobile-0.4.0.apk` (versionCode 15)
- 공개 소스: `Mr.Robot-source-0.4.0.zip`
- SHA-256: `SHA256SUMS-0.4.0.txt`

Windows 설치본은 Authenticode로 서명되지 않아 SmartScreen이 표시될 수 있습니다. 배포한 checksum을 확인하세요. Android APK는 0.3.0 이후와 같은 릴리스 인증서로 서명되어 0.3.0~0.3.9 위에 업데이트할 수 있습니다.

## 원격 연결 보안 기본값

Remote Link, Tailscale, Orca는 기본 OFF입니다. PC 앱은 이 플러그인 없이 로컬 Agent로 독립 실행합니다. Cloudflare 고정 연결을 사용할 때는 호스트 전체 Access, 소유자 이메일 Allow, Mr.Robot 전용 Service Token의 Service Auth만 사용하고 Bypass·Everyone을 두지 마세요.

Cloudflare Tunnel과 Access 자체는 이 구성에 유료 Worker/R2/Images/Stream/Log Explorer를 추가하지 않으면 별도 종량제 서비스를 요구하지 않습니다. 각 PC는 고유 hostname과 전용 Tunnel을 사용해야 합니다.

## 검증

- TypeScript typecheck, production build, 전체 기능·보안·UI 테스트 통과
- 메모리 장기 반복 검사 통과 (`NO LEAK DETECTED`)
- root/mobile production dependency audit 0 vulnerabilities
- 공개 소스·Git 이력·LFS pointer·desktop stage 민감정보 검사 통과
- Android 기존 signer 연속성과 APK Signature Scheme v2 확인

런타임 설정, API key, Tunnel token, Access ID/Secret, pairing/PIN, 기기 token, 서명 key/password와 개인 데이터는 릴리스에 포함되지 않습니다.
