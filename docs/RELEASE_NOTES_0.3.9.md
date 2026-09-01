# Mr.Robot 0.3.9

0.3.9는 한 대를 고정된 “모체 PC”로 두지 않고 PC 1·PC 2·휴대폰을 각각 독립 등록한 뒤, 지금 명령을 실행할 PC를 즉시 바꿀 수 있게 한 다중 기기·원격 연결 보안 릴리스입니다. 데스크톱은 원격 연결 플러그인을 켜지 않아도 기존처럼 로컬 단독 에이전트로 동작합니다.

## 고정 모체 없는 다중 PC

- PC마다 별도의 등록 정보, 기기 토큰, 연결 origin, Cloudflare Access origin을 유지합니다. PC를 다시 등록하거나 이름을 바꿔도 다른 PC의 자격증명을 덮어쓰지 않습니다.
- 데스크톱의 대화 빠른 설정과 프로필 메뉴, Android 상단의 실행 PC 선택 창에서 이후 명령과 파일 작업을 처리할 PC를 바꿀 수 있습니다.
- PC 1과 PC 2를 휴대폰 한 대에 함께 등록할 수 있습니다. 휴대폰은 현재 선택한 실행 PC에 연결하며, 필요할 때 다른 PC로 전환합니다.
- 데스크톱은 마지막으로 선택한 원격 실행 PC를 재시작 뒤 복원합니다. 해당 PC가 삭제됐거나 연결에 실패하면 저장값을 폐기하고 내장 로컬 Agent로 안전하게 돌아갑니다.
- 모바일에서 실행 PC를 바꿀 때 이전 연결 세대를 먼저 무효화하고 소켓과 재연결 타이머를 정리합니다. 늦게 도착한 이전 PC의 close·재시도 이벤트가 선택을 되돌리는 재연결 race를 차단했습니다.
- 실행 중인 작업이 있으면 데스크톱 상단·프로필과 Android 실행 PC 선택 창 모두 전환·연결 관리를 잠급니다. 기존 PC에서 작업과 토큰 사용이 보이지 않게 계속되는 상태를 만들지 않고, 완료 또는 중지 뒤 전환하도록 안내합니다.
- 파일 전송과 PC 간 작업 동기화는 각 대상 PC에 저장된 정확한 보안 origin과 권한 범위를 사용합니다.

## 선택형 Remote Link 플러그인

- `remote-link`는 기본값이 OFF인 선택형 built-in 플러그인 모듈입니다. Agent의 플러그인 수명주기·권한·상태 저장 경계에서 활성화되지만, 현재는 EXE에 함께 포함되며 별도로 설치하거나 독립 업데이트하는 외부 플러그인은 아닙니다.
- Cloudflare Quick Tunnel은 임시 연결용으로 유지하고, 상시 원격 연결에는 사용자 도메인의 Named Tunnel과 Cloudflare Access를 사용합니다.
- Named Tunnel의 호스트명, Tunnel 토큰, Access Service Token, 자동 시작 여부를 플러그인 화면에서 관리할 수 있습니다. Tunnel과 Access 자격증명은 상태·로그·명령줄·QR에 반환하지 않습니다.
- 사용자가 자동 시작을 켠 Named Tunnel은 Mr.Robot 플러그인이 활성화될 때 다시 연결합니다. 저장된 설정을 잃지 않고 Quick Tunnel을 일시 사용한 뒤 Named Tunnel로 돌아갈 수 있습니다.
- 시작과 자동 시작은 외부 검증까지 하나의 단계로 취급합니다. Access 검증이 실패하면 Named Tunnel 프로세스를 중지하고 오류를 남겨, “Tunnel은 열렸지만 Access가 빠진” 상태로 계속 실행하지 않습니다.

## Cloudflare Access fail-closed 검증

- 익명 `/api/ping` 요청에서 정확한 Mr.Robot Agent 표식이 보이지 않아야 합니다.
- 익명 `/api/ws-ticket`과 `/api/pair` 요청에서 정확한 Agent 오류 표식이 보이지 않아야 하며, Service Token을 넣은 요청에서는 예상된 Agent 응답만 확인되어야 합니다.
- Service Token으로 인증한 `/api/ping`이 정확한 Mr.Robot Agent 응답을 반환해야 검증 상태를 성공으로 기록합니다.
- 각 요청은 리디렉션을 따르지 않습니다. 경로 일부만 보호하거나 Access가 빠진 구성, 다른 서버로 연결된 호스트, 잘못된 Service Token은 실패로 닫히고 실행 중인 Named Tunnel도 중지됩니다.
- 실제 릴리스 검증에서 익명 ping·ws-ticket·pair 차단, Service Token ping의 정확한 Agent 응답, 1회용 티켓 발급, 외부 `wss://` 연결, `mr-robot-rpc-v1` 협상, 관리자 인증·상태 RPC, 앱 재시작 뒤 Named Tunnel 자동 복구를 모두 확인했습니다.

## 자격증명과 공개 릴리스 경계

- Windows의 Tunnel 토큰과 Access 자격증명은 CurrentUser DPAPI로 암호화해 사용자 런타임 플러그인 저장소에만 보관합니다. Android의 PC별 기기 토큰과 Access 자격증명은 SecureStore/Keystore에만 보관합니다.
- Electron renderer에는 관리자 secret, 저장된 기기 토큰, Tunnel 토큰, Access Client Secret 평문을 전달하지 않습니다. 원격 요청에는 main process가 등록된 정확한 HTTPS origin에만 필요한 헤더를 주입합니다.
- 장기 Access 자격증명은 페어링 QR, 1회용 외출 코드, 로그, 오류 메시지, 상태 RPC, 릴리스 문서에 포함하지 않습니다.
- 저장소의 설정·플러그인 상태·공유 파일·런타임 폴더·서명키 경로를 ignore하며, 저장소 루트를 런타임 홈으로 잘못 지정해도 추적되지 않도록 방어합니다.
- `npm run audit:public`은 현재 추적 파일, 도달 가능한 Git 이력, LFS 포인터, Desktop stage를 검사합니다. 소스 ZIP은 이 감사가 통과한 깨끗한 Git `HEAD`에서만 만들며, 미추적 소스가 있으면 실패합니다.
- 공개 GitHub와 소스 ZIP에는 provider API 키, Cloudflare 자격증명, 기기 토큰, pairing secret/PIN, DPAPI ciphertext, Android 서명키, 개인 캘린더·업무 파일을 넣지 않습니다. 이 규칙은 built-in 플러그인의 런타임 설정에도 동일하게 적용됩니다.

## 무료 운영 기준

- Cloudflare Zero Trust Free의 Tunnel과 Access만 사용하며, 유료 Workers·R2·Images·Stream·Log Explorer를 원격 경로에 추가하지 않습니다.
- Access 앱은 정확한 Mr.Robot 호스트 하나를 대상으로 하고, 본인 이메일 Allow와 지정 Service Token의 Service Auth만 사용합니다. `Everyone`·`Bypass` 정책은 두지 않습니다.
- 외부에서 PC 두 대를 독립 대상으로 사용하려면 PC마다 고유한 서브도메인과 전용 Tunnel을 구성합니다. 하나의 호스트명을 두 Connector가 공유하면 요청 대상이 섞일 수 있으므로 플러그인 화면에서도 이를 경고합니다.
- 이 계정에 의도적으로 공개할 다른 호스트가 없다면 account-wide default deny를 켜서 Access 앱 설정을 빠뜨린 새 호스트도 기본 차단합니다.
- 외부 연결은 실행 PC가 켜져 있고 인터넷에 연결되어 있으며 Mr.Robot과 Connector가 실행 중일 때만 유지됩니다. Cloudflare는 PC를 대신 실행하거나 오프라인 파일을 보관하는 서버가 아닙니다.

## 호환성 및 릴리스 상태

- Desktop/Web/Agent: 0.3.9
- Android: versionName 0.3.9, versionCode 14
- 기존 secret 없는 v3 페어링 QR과 Quick Link를 계속 지원합니다.
- Windows x64 installer: 96,036,171 bytes, SHA-256 `4E652F32AB7ED00860D6C0C78C28DEF16553D5308AF82C7192D1FEBBFD41B84E`. Authenticode 서명은 없으므로 SmartScreen 경고가 나타날 수 있습니다.
- Android APK: 87,558,760 bytes, SHA-256 `C45AE3DFB93DD0CEF3ED6C6AF1B050EBD37E5A6835117E9D91994AAE1F3D0963`. 기존 공식 인증서 SHA-256 `EB782D956DABCA784D9E0AFC152BF7061ACE72CE805215E3C6502AAE72E1A0E6`과 APK Signature Scheme v2를 확인했습니다.
- 소스 ZIP과 세 파일의 통합 체크섬은 이 문서를 포함한 깨끗한 릴리스 `HEAD`에서 생성되는 `SHA256SUMS-0.3.9.txt`를 기준으로 확인합니다.
