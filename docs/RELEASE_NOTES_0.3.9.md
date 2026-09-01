# Mr.Robot 0.3.9

Cloudflare Zero Trust Free 환경에서 원격 PC를 공개하지 않고 Desktop·Android·브라우저·PC 간 전송을 함께 사용할 수 있도록 원격 연결 경계를 완성한 보안 릴리스입니다.

## Cloudflare Access

- 고정 Tunnel 설정에 Access Service Token Client ID/Secret을 추가했습니다. Windows에서는 DPAPI, Android에서는 SecureStore/Keystore에 저장하며 일반 설정·AsyncStorage·로그·상태 응답에는 평문을 남기지 않습니다.
- REST, WebSocket 티켓, WSS 업그레이드, 첨부 업로드, 파일 업로드·다운로드, PC 간 파일 가져오기와 작업 동기화가 Access 뒤에서도 동작합니다.
- 외부 연결 검사는 익명 요청이 차단되고 Service Token 요청만 성공해야 통과합니다. 공개된 Tunnel을 Access 보호로 오인하지 않습니다.
- PC 간 전송용 Access 헤더는 공개 접미사 목록(eTLD+1, private suffix 포함)으로 같은 소유 도메인임을 확인한 정확한 호스트에만 전송합니다. `github.io` 같은 공유 도메인의 다른 사용자, 유사 도메인·HTTP·비표준 포트는 실패로 닫힙니다.
- 고정 Tunnel QR은 장기 Service Token을 포함하지 않습니다. 관리자가 승인한 뒤 주소와 1회용 외출 코드만 60초 표시하고, 상태 변경·폐기·화면 종료 때 즉시 지웁니다. Access Client ID/Secret은 스캔 뒤 Android에서 직접 입력해 SecureStore/Keystore에만 저장합니다.

## 자격증명 유출 방지

- Electron renderer의 실제 PC 토큰과 Access 토큰은 main process 경계 밖으로 나오지 않습니다.
- Chromium 리디렉션이 기존 커스텀 헤더를 재사용해도 매 요청마다 먼저 제거하고, 등록된 정확한 origin의 `/api/` 요청에만 다시 주입합니다.
- Access 자격증명과 기기 토큰의 권한 범위는 등록에 성공한 main-process 소유 origin 하나에 고정됩니다. 렌더러나 보조 주소가 origin을 추가해도 자격증명 범위는 넓어지지 않습니다.
- Desktop의 보안 저장소 네트워크 요청은 원격 HTTPS만 허용하고 DNS의 모든 주소를 검사한 뒤 한 주소로 고정해 SNI/TLS 인증서를 검증합니다. loopback 이외의 평문 주소와 내부·링크 로컬·예약 주소 SSRF는 차단합니다.
- 브라우저·모바일의 자격증명 포함 fetch는 리디렉션을 거부합니다. 브라우저 Access 로그인 쿠키는 같은 origin에만 보냅니다.
- Android의 스트리밍 파일 업로드·다운로드도 의존성 설치 때 리디렉션 차단 패치를 검증하고 소스에서 빌드합니다. 의존성 구조가 바뀌어 패치를 확인할 수 없으면 설치·빌드를 실패시킵니다.
- Tunnel Connector는 계속 loopback Agent 한 경로와 404 catch-all만 실행하며, 토큰은 명령줄에 넣지 않습니다.

## 무료 운영 기준

- Cloudflare Zero Trust Free + Tunnel + Access만 사용합니다.
- Self-hosted 앱은 정확한 Mr.Robot 호스트만 대상으로 하고, 본인 이메일 Allow와 정확한 Service Token의 Service Auth만 사용합니다.
- Bypass·Everyone·유료 Workers/R2/Images/Stream·Log Explorer는 사용하지 않습니다.
- 계정에 다른 공개 호스트가 없음을 확인한 뒤 Access의 account-wide default deny를 켜는 구성을 권장합니다.
- 일반 브라우저는 보호된 원격 주소를 직접 열어 같은-origin Access 로그인으로 사용합니다. 다른 웹사이트에서 원격 주소로 교차-origin Service Token 연결을 시도하는 흐름은 지원하지 않습니다.

## 호환성

- Desktop/Web/Agent: 0.3.9
- Android: versionName 0.3.9, versionCode 14
- 기존 v3 QR과 Quick Link는 계속 지원합니다. 고정 Tunnel QR도 secret 없는 v3 handoff 형식이며 Android가 Access 값을 로컬 입력받습니다.
