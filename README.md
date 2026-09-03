# Mr.Robot — 모바일 ↔ PC AI 에이전트 (Windows)

> 현재 릴리스: **0.4.3**. 빠른 사용법은 [docs/USER_GUIDE_0.3.md](docs/USER_GUIDE_0.3.md), 변경 사항은 [docs/RELEASE_NOTES_0.4.3.md](docs/RELEASE_NOTES_0.4.3.md), 새 플러그인의 독립 구현·기능 비교는 [docs/PLUGIN_COMPARISON_0.4.2.md](docs/PLUGIN_COMPARISON_0.4.2.md), 설계·연구·라이선스 근거는 [docs/RESEARCH_AND_LICENSES.md](docs/RESEARCH_AND_LICENSES.md)를 먼저 보세요.

PC의 **모든 기능**(셸·파일·앱·마우스/키보드·화면)을 PC 에이전트가 권한 정책 아래 사용하고, 폰에서 토큰으로 연결해 작업을 위임하는 개인용 에이전트입니다.

```
┌─────────────┐   WebSocket(WS) + HTTP   ┌──────────────────────────────┐
│  React Native│ ◄──────────────────────► │  Mr.Robot Agent (Node.js)       │
│  (폰 앱)     │     페어링 토큰 인증      │  ├─ AI 제공자 (아무 키나)      │
│  · 다중 대화 │                          │  ├─ 도구 호출 루프 (권한 제어) │
│  · 작업 위임 │ ◄──────────────────────► │  ├─ 컴퓨터 제어 (Win32/PowerShell)│
└─────────────┘   다중 PC 등록·전환       │  ├─ 플러그인 (누수 0)          │
                                          │  ├─ 예약 작업 스케줄러        │
┌─────────────┐   같은 프로토콜           │  └─ 웹 UI 서빙               │
│  웹 UI /     │ ◄──────────────────────► └──────────────────────────────┘
│  Electron 셸 │
└─────────────┘
```

## 기능

- 🤖 **모바일 → PC 에이전트 위임** — 폰의 요청을 토큰으로 연결된 PC 에이전트가 받아 실제 작업 실행
- 💬 **영속 다중 대화** — 대화별 컨텍스트·모델·추론 강도, 보관/복원/삭제, 큰 컨텍스트 자동 압축
- 🧠 **비용 인식 모델 라우팅** — 빠른 처리·일반·심층 사고·코딩·시각·검토·요약 역할별 모델 노드
- 🌳 **의사결정 트리 프리셋** — 절약·균형·품질·코딩 기본 트리와 사용자 트리를 저장·적용·덮어쓰기·삭제
- 🖥️🖥️ **다중 PC 등록·전환** — PC 여러 대를 등록하고 언제든 전환
- ⏰ **예약 작업** — 특정 시각에 자동 실행 (일회성/매일/요일 반복): AI 작업·셸 명령·앱 실행
- 🔌 **분류형 플러그인 + 작업 화면** — 시스템·연결/생산성/개발/모의해킹/기타로 묶고, 필요한 플러그인은 목록 안의 전용 작업 화면에서 입력·사전 점검·승인·실행 결과까지 처리
- 📦 **허가된 웹 리소스 보존** — 이미 받은 HAR/캡처 본문을 우선 재사용하고, 선택한 경우에만 제한된 공개 자산을 요청해 오프라인 링크·SHA-256 manifest·중복 제거가 포함된 ZIP 생성
- 🔎 **독립 SSL/TLS 점검** — 허가된 공개 호스트 하나의 TLS 버전·제한 암호군·인증서·정책 진단을 빠른 4연결 기본값과 캐시로 제공
- 🧹 **결정적 플러그인 정리** — 붙였다 떼도 메모리 누수 0 (리스너·타이머·명령·모듈 캐시 전부 자동 정리, 600회 부착/분리 테스트 통과)
- 🐋 **Orca 코딩 실행기** — 코딩 요청을 격리된 Orca worktree의 Codex·Claude 에이전트로 위임하고 상태·터미널을 다시 Mr.Robot에서 확인
- 🔑 **모델 모듈 자유 선택** — API, 무료 원격, Ollama/LM Studio 로컬, 공식 Codex/Claude CLI를 등록하고 모델을 나중에도 즉시 변경
- 🛡️ **4단계 권한** — 읽기 전용·변경 전 승인·지정 폴더 자동·전체 허용, 페어링 토큰 인증, PIN 교환 rate-limit
- 🎨 **다크 글래스모피즘 UI** — 데스크톱 창·브라우저·폰 공용
- 📁 **대화별 작업 폴더** — 폴더를 고른 뒤 Codex/Claude Code가 그 폴더에서 네이티브 에이전트로 직접 작업
- 🎙️ **PC 음성 호출·명령** — 설정 가능한 `로봇` 호출어, 로컬 고정확도 한국어 인식과 사용자 지정 응답 음성. 모바일은 안정적인 텍스트·파일 제어에 집중
- 📤 **토큰 없는 파일 전송·동기화** — 공유함·작업 폴더 스트리밍, PC 간 90초 1회성 권한, 기기별 동기화 권한, 충돌 복사본 보존, 취소·부분파일 자동 정리
- ☁️ **VPN 없는 Cloudflare 연결** — 계정 없는 임시 Quick Link 또는 Access 이중 인증·자동 재연결을 갖춘 사용자 도메인 고정 Tunnel, Tailscale은 기본 OFF 선택 플러그인
- 📌 **상용 앱형 대화 UX** — 대화 고정/고정 우선 정렬, 우클릭 이름 변경·보관·삭제, 다중 파일 드래그앤드롭
- 🔐 **대화별 액세스** — 모델·시나리오·작업 폴더 옆에서 읽기/승인/폴더/전체 권한을 바로 선택하고 대화에 저장
- 📅 **개인 근무 캘린더** — 읽기 전용 `.xlsx` 가져오기, 서울 기준 월간 달력·공휴일·수동 근무지 수정, 동의 기반 NAVER 경로 연결을 DPAPI 암호화 상태로 관리
- 🧪 **CTF + Docker 플러그인** — 네트워크 차단·읽기 전용·권한 제거·자원 제한 샌드박스와 재사용 도구 이미지
- 🔗 **MCP 호스트 플러그인** — stdio MCP 서버를 필요할 때만 연결하고 도구별 승인을 거쳐 호출
- ♻️ **장시간 작업·저장 복원력** — 연결이 끊겨도 작업은 계속되고 같은 기기가 상태·승인을 복구하며, 손상된 설정·대화는 원본 격리 후 마지막 정상 백업으로 복원

## 요구사항

- Windows 10/11, Node.js 20.19+ (npm 10+)
- 폰: Expo Go 앱(테스트용) 또는 Android 빌드

## 설치 & 실행

```powershell
cd mr-robot
npm install
npm run build        # shared + agent + web 빌드
```

### 1) 에이전트 + 웹 UI (가장 간단)

```powershell
npm run start:agent
```

브라우저에서 <http://127.0.0.1:8787> 접속. 화면의 설정 → 모바일 연결 탭에 QR/PIN 표시.

### 2) 데스크톱 앱 (Electron — 창 + 트레이)

```powershell
npm run build
npm run dev:desktop
```

창을 닫아도 트레이에 남아 계속 실행됩니다 (폰 연결 유지).

Windows x64 설치 파일 생성:

```powershell
npm run build:installer
```

결과는 `release/Mr.Robot-Setup-0.4.3-x64.exe`입니다. 현재 빌드는 개발용 미서명 설치 파일이므로 조직의 Windows 애플리케이션 제어 정책에서 차단될 수 있습니다. 공개 배포본에는 코드 서명 인증서를 적용해야 합니다.

설치 후 처음 실행하면 **외부 도구 및 의존성 마법사 v5**가 열립니다. 모든 항목을 실제 실행 파일로 검사하고, Node.js LTS·Git·PC 음성·Codex·Claude와 Quick Link용 cloudflared를 누락 시 자동 설치합니다. cloudflared는 x64 사용자 범위 portable 패키지로 설치하며 플러그인 화면의 전용 설치 버튼으로도 다시 시도할 수 있습니다. Tailscale, Docker, Orca, Ollama는 계속 선택 플러그인·기능으로 유지됩니다. 완료 후에도 설정 → 외부 도구에서 다시 검사하거나 설치할 수 있습니다. Codex·Claude 계정 로그인은 자격 증명을 앱에 복사하지 않고 각 공식 CLI에서 직접 진행합니다.

### 3) 모바일 앱 (React Native / Expo)

```powershell
cd apps/mobile
npm install
npx expo start          # Expo Go 개발 실행
# 또는 네이티브 빌드:
npx expo run:android
```

1. 앱 실행 → `＋ PIN으로 PC 추가` 또는 `QR 코드 스캔`
2. PC 화면의 **QR 코드**를 스캔하거나, **PC 주소 + PIN** 입력
3. 하단 탭에서 **대화 / 예약 / 설정** 전환. 대화 입력창 아래에서 현재 모델이 지원하는 추론 강도 선택
4. PC 여러 대 등록 가능 — 상단 `PC 전환` 버튼으로 전환

Android 0.4.0은 versionCode 15이며 기존 Mr.Robot 릴리스 인증서로 `release/mobile/Mr.Robot-Mobile-0.4.0.apk`를 만듭니다. 0.3.0~0.3.9에서 바로 업데이트할 수 있습니다. 휴대폰에 VPN을 켜지 않으려면 PC의 Cloudflare 임시 또는 고정 Tunnel을 시작한 뒤 HTTPS 주소/QR을 사용합니다. 고정 Tunnel QR에는 12자리·10분·1회용 외출 코드와 최대 5분의 서버 결합 Access assertion만 들어가며 장기 Service Token은 포함되지 않습니다. 첫 등록이 성공하면 PC가 장기 Access 자격과 기기 토큰을 한 번만 전달하고 Android는 PC별 버전형 SecureStore bundle에 원자 저장합니다. 사용자가 Client ID/Secret을 직접 복사할 필요는 없습니다. Tailscale을 쓰는 경우에도 인증 연결은 Serve가 제공하는 HTTPS 이름을 사용합니다. 숫자형 `100.64/10` 및 일반 HTTP Wi-Fi/LAN 주소로 인증정보를 보내는 연결은 차단됩니다.

## 모델 모듈과 라우팅 설정

설정 → AI 제공자 → 추가. 지원 타입과 Base URL 예시:

| 타입 | Base URL | 비고 |
|---|---|---|
| OpenAI 호환 | `https://api.openai.com/v1` | OpenAI, 또는 아래 전부 |
| (Groq) | `https://api.groq.com/openai/v1` | |
| (DeepSeek) | `https://api.deepseek.com/v1` | |
| (OpenRouter) | `https://openrouter.ai/api/v1` | 여러 모델 중계 |
| (Mistral/xAI/기타) | 공급사 문서의 `/v1` 주소 | API가 호환되면 전부 동작 |
| Anthropic | `https://api.anthropic.com` | Claude |
| Ollama (로컬) | `http://127.0.0.1:11434` | 키 불필요, 무료 로컬 모델 |
| Codex 구독 CLI | URL 불필요 | 공식 `codex` 명령에 먼저 로그인 |
| Claude 구독 CLI | URL 불필요 | 공식 `claude` 명령에 먼저 로그인 |

API 키는 Windows DPAPI(CurrentUser)로 암호화한 뒤 **PC의 `~/.mr-robot/config.json`에만 저장**됩니다. 기존 평문 키는 시작 시 자동 마이그레이션됩니다. 구독형 모듈은 로그인 자격 증명을 복사하지 않고 공식 CLI를 실행합니다.

설정 → 모델 라우팅에서 LangChain식 캔버스에 입력·분류·모델·검증·메모리·응답 노드를 자유 배치하고 연결합니다. 절약·균형·품질·코딩 기본 의사결정 트리를 고르거나 현재 트리를 사용자 프리셋으로 저장해 목록에서 다시 적용할 수 있습니다. 모델 노드의 역할과 제공자를 선택하면 그래프 순서가 실제 역할별 우선순위가 됩니다. 대화에서 특정 모델을 고르면 자동 라우팅보다 우선합니다. 추론 강도는 데스크톱과 모바일 모두 입력창 하단에서 자동/없음/낮음/보통/높음/매우 높음/최대 중 현재 제공자가 지원하는 값만 선택하며 대화마다 저장됩니다. 같은 화면에서 토큰·도구 호출·실패·지연·예상 비용 통계를 확인합니다.

## Orca 연결

Mr.Robot에는 `Orca 코딩 실행기`가 기본 플러그인으로 포함되지만 위임과 자동 실행은 기본적으로 꺼져 있습니다. 필요할 때 Orca를 설치·실행한 뒤 플러그인 화면에서 직접 활성화하고 `orca.exe` 경로와 기본 Codex/Claude 에이전트를 저장하세요. 라우팅 캔버스의 `＋ Orca 실행기` 노드를 원하는 위치에 배치할 수도 있습니다.

- 일반 대화에는 Orca 도구 정의를 넣지 않아 토큰을 쓰지 않습니다.
- 코딩 요청에서만 저장소 조회, worktree 상태, `worktree create`, 터미널 읽기/응답 도구를 노출합니다.
- 새 worktree 생성과 터미널 입력은 Mr.Robot의 현재 권한 단계에 따라 승인받습니다. 상태·목록·터미널 읽기는 읽기 전용으로 처리합니다.
- 위임은 공식 Orca CLI의 JSON 명령을 사용하며, 셸 문자열을 조합하지 않고 인자를 직접 전달합니다.

공식 CLI 등록과 명령은 [Orca CLI 문서](https://www.onorca.dev/docs/cli/reference)를 따릅니다. 기본 흐름은 `orca.repos`로 selector 확인 → `orca.delegate`로 Codex/Claude 작업 시작 → `orca.worktrees`/`orca.terminal.read`로 진행 확인입니다.

## 예약 작업

예약 작업 탭 → 추가. 정해진 시각에 PC에서 자동 실행됩니다:

- **AI 작업** — "매일 아침 9시에 뉴스 요약해서 바탕화면에 저장해줘" 같은 프롬프트를 예약 시각에 AI가 실행
- **셸 명령** — PowerShell/CMD 명령
- **앱 실행** — 프로그램/파일/URL 열기
- 일회성(`YYYY-MM-DD HH:MM`) 또는 반복(매일/요일 선택)

## 플러그인

플러그인 탭은 플러그인을 **시스템·연결 / 생산성 / 개발 / 모의해킹 / 기타**로 묶어 표시합니다. 관리자는 각 플러그인의 카테고리를 바꿀 수 있고 선택은 호스트 설정에 유지됩니다. `작업 화면` 버튼을 누르면 목록을 떠나지 않고 해당 플러그인의 입력, 안전 한도, 실행 전 확인, 진행률과 결과를 한 화면에서 다룰 수 있습니다. 검토된 기본 플러그인만 직접 실행 UI를 제공하며, 외부 플러그인의 임의 명령은 자동 실행하지 않습니다.

0.4.2에 포함된 모의해킹 카테고리의 기본 플러그인:

- **Authorized Web Resource Archiver** — HAR/브라우저 캡처 응답은 네트워크 요청 0회로 보존할 수 있습니다. 직접 수집은 명시적으로 켜야 하며 네이티브 작업 화면의 기본값은 재시도 0회, 동시 요청 2개, 1단계 의존성, 리디렉션을 포함한 물리 GET 최대 40회, 전체 60초입니다. 독립 포털은 더 좁게 동시 요청 1개·물리 GET 최대 20회·전체 30초로 고정합니다.
- **SSL/TLS Inspector** — URL·CIDR·목록이 아닌 허가된 공개 호스트 하나만 받습니다. 기본 `quick`은 TLS 1.0~1.3 핸드셰이크 4회와 인증서만 확인하며 개별 암호군 탐색은 하지 않습니다. `standard`도 대표 암호군을 최대 12개만 추가 확인하므로 프로토콜 점검을 합쳐 TLS 연결은 최대 16회입니다. 같은 조건의 결과는 기본 5분 캐시됩니다.
- **WebCrypto Runtime Observer** — 붙여넣은 JavaScript를 실행 없이 분석하거나, 허가목록의 HTTPS 443 URL 하나를 별도 임시 Chrome/Edge 프로필에서 기본 10초·20요청으로 관찰합니다. 기본은 메타데이터 전용입니다. 일회성 변경은 평문 미리보기를 켠 같은 세션에서 실제 관찰된, 잘리지 않은 동일 단계의 UTF-8 literal(1~64바이트)과 정확히 일치할 때만 별도 승인 후 등록할 수 있습니다.

세 플러그인 모두 대상 소유 또는 명시적 허가 확인과 실행별 승인을 요구합니다. Resource Archiver는 같은 호스트와 정확히 허용한 공개 DNS 호스트만 GET하며, SSL/TLS Inspector는 허용 포트의 직접 TLS만 점검합니다. Runtime Observer는 기존 브라우저 쿠키를 사용하지 않고 다른 origin과 보조 트래픽 채널을 차단합니다. 사설·loopback·link-local·예약 주소와 DNS rebinding 경로는 기본 차단됩니다. 세 엔진은 외부 확장 프로그램이나 공식 `sslscan`의 소스·바이너리를 복사·변형·번들하지 않은 독립 구현입니다. 기능 범위와 비교 근거는 [플러그인 비교 문서](docs/PLUGIN_COMPARISON_0.4.2.md)에 정리했습니다.

세 도구는 네이티브 앱의 `설정 → 도구 포털`에서 전용 비밀번호를 설정한 뒤 `/tools/resource-archiver`, `/tools/sslscan`, `/tools/runtime-hook`에서 각각 열 수 있습니다. 능동 접속 전에는 와일드카드·접미사 매칭·포트·경로가 없는 정확한 대상 DNS 이름을 허용목록에 넣어야 하며, 작업 폴더는 ZIP 보관에만 필요하고 상태 변경·literal 변경 opt-in은 선택 사항입니다. 포털은 기본 OFF이며 외부 주소에서는 검증된 Cloudflare Named Tunnel + Access 경계와 포털 비밀번호를 함께 요구합니다. 로그인 권한은 HttpOnly 쿠키와 포트별 탭 저장소의 별도 요청 증명을 모두 제시해야 하므로 같은 loopback 호스트의 다른 포트에 쿠키가 전달돼도 단독 재사용할 수 없습니다.

외부 플러그인은 경로로 불러오거나 제거할 수 있습니다. 예제:

```
examples/plugins/hello    — 명령 등록 예제
examples/plugins/monitor  — 이벤트 구독 + 타이머 예제
```

플러그인은 JS 모듈입니다 (`index.js`/`.mjs`/`.cjs`):

```js
export const plugin = {
  manifest: { id: 'my-plugin', name: 'My Plugin', version: '1.0.0', category: 'other', description: '…' },
  activate(ctx) {
    ctx.on('plugins.changed', (list) => ctx.logger.info('plugins: ' + list.map(p => p.id)));
    ctx.setInterval(() => ctx.logger.debug('tick'), 5000);       // 언로드 시 자동 정리
    ctx.registerCommand('my.do', (params) => ({ ok: true }), { tool: true, description: 'AI에게 노출' });
    ctx.storage.set('hello', 1);                                  // 영구 저장
    ctx.computer.shell('echo hi');                                // 컴퓨터 API 직접 사용
  },
  deactivate(ctx) { /* 정리 코드 */ },
};
```

manifest의 `category`에는 `system`, `productivity`, `development`, `pentest`, `other` 중 하나를 씁니다. 생략한 외부 플러그인은 `other`로 시작하며 관리자가 화면에서 바꿀 수 있습니다.

**누수 없는 이유**: 플러그인이 `ctx`를 통해 만든 모든 리소스(이벤트 구독·타이머·명령)를 관리자가 추적하고, 언로드 시 ①`deactivate()` 호출 → ②구독 해제 → ③타이머 해제 → ④명령 제거 → ⑤모듈 캐시 제거 → ⑥참조 해제 순서로 결정적으로 정리합니다. ESM 모듈은 파일 mtime 기반 캐시라서 같은 파일의 재로드는 모듈 맵에 아무것도 쌓지 않습니다(누수 테스트로 검증). 단, **모듈 스코프 변수는 파일 수정 전까지 유지**되므로 로드마다 초기화되는 상태는 `ctx`(storage 등)에 두세요.

누수 검증은 `npm run test:leak` — 플러그인 600회·WS 80회·스트리밍 20회 반복 후 힙이 수렴하는지 측정합니다.

## 보안

- 기본은 **이 PC 전용(loopback)** 이며, 원격 인증 연결은 Cloudflare 또는 Tailscale Serve의 HTTPS 주소만 허용합니다.
- 새 QR에는 관리자 시크릿이 없습니다. 로컬 등록은 짧은 1회용 PIN을, Cloudflare 원격 등록은 12자리·10분·1회용 외출 코드와 최대 5분의 서버 결합 assertion을 사용합니다. 교환 후에는 해시로만 저장되는 **기기별 폐기 가능 토큰**을 발급하고 코드는 즉시 소비됩니다.
- 각 기기는 읽기 전용/승인/작업 폴더/전체 권한 상한을 별도로 가지며, PC에서 한 기기만 즉시 연결 해제할 수 있습니다.
- PIN 교환은 클라이언트별 5분 5회, 전체 5분 50회로 제한되며 새 PIN 발급 시 새 등록 구간으로 초기화됩니다
- 직접 PC 조작 RPC는 `전체 허용` 모드가 아니면 차단되고, 일반 작업은 에이전트 도구 권한 정책을 통과
- 외부 접속은 기본 OFF인 Cloudflare Quick Link 또는 선택형 Tailscale 플러그인을 사용하며, 어떤 전송에서도 기기별 토큰 인증은 유지됩니다
- `~/.mr-robot/` 에 설정·대화·기억·예약·라우팅 통계가 저장됩니다. API 키 값은 Windows 사용자 계정에 묶인 DPAPI 암호문으로만 기록됩니다.
- 개인 근무표는 원본 Excel을 읽기 전용으로만 열고 필요한 날짜·근무지 값만 `~/.mr-robot/private/work-calendar/state.bin`의 DPAPI 암호문에 저장합니다. 원본 파일·행 식별값·NAVER 키는 Git이나 일반 기기 동기화에 넣지 않습니다.
- 공개 GitHub 저장소의 **Secret scanning**과 **Push protection**을 켜서 알려진 비밀 패턴의 이력 탐지와 새 push 차단을 함께 적용합니다. 이는 로컬 DPAPI·로그 마스킹·릴리스 감사와 별개의 저장소 방어선입니다.

## 구조

```
mr-robot/
├─ packages/
│  ├─ shared/     공통 프로토콜/도구 정의
│  ├─ agent/      에이전트 코어 (서버·AI·컴퓨터 제어·플러그인·스케줄러)
│  ├─ web/        React UI (데스크톱 창·브라우저 공용)
│  └─ desktop/    Electron 셸 (에이전트 내장, 트레이)
├─ apps/
│  └─ mobile/     React Native(Expo) 앱 — 다중 대화/작업 위임/예약/설정, 다중 PC
└─ examples/
   └─ plugins/    예제 플러그인
```

## 테스트

```powershell
npm run build
npm test                # 스모크 + 스케줄러 + AI 루프(모의 서버) 통합 테스트
npm run test:leak       # 메모리 누수 측정 (플러그인 600회·WS 80회·스트리밍 20회)
```

## 문제 해결

- **포트 충돌**: 설정 → 네트워크에서 포트 변경, 또는 `node packages/agent/dist/index.js --port 9000`
- **폰에서 접속 불가**: PC 플러그인에서 Cloudflare 링크가 실행 중인지 확인하고 새 HTTPS QR을 등록하세요. Tailscale을 선택했다면 raw IP 대신 Tailscale Serve의 HTTPS 이름을 입력하세요.
- **예전에 등록한 `192.168.x.x` 또는 `100.64.x.x` 주소가 안 될 때**: 주소 범위만으로 암호화 경로를 증명할 수 없어 평문 원격 인증을 차단했습니다. 해당 PC 등록을 지우고 Cloudflare 또는 Tailscale Serve HTTPS 주소로 다시 등록하세요.
- **Expo 버전 조정**: `cd apps/mobile && npx expo install --fix`
