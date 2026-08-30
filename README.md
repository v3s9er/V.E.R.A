# Mr.Robot — 모바일 ↔ PC AI 에이전트 (Windows)

> 현재 릴리스: **0.3.0**. 빠른 사용법은 [docs/USER_GUIDE_0.3.md](docs/USER_GUIDE_0.3.md), 설계·연구·라이선스 근거는 [docs/RESEARCH_AND_LICENSES.md](docs/RESEARCH_AND_LICENSES.md)를 먼저 보세요.

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
- 🔌 **플러그인** — 붙였다 떼도 메모리 누수 0 (리스너·타이머·명령·모듈 캐시 전부 자동 정리, 600회 부착/분리 테스트 통과)
- 🐋 **Orca 코딩 실행기** — 코딩 요청을 격리된 Orca worktree의 Codex·Claude 에이전트로 위임하고 상태·터미널을 다시 Mr.Robot에서 확인
- 🔑 **모델 모듈 자유 선택** — API, 무료 원격, Ollama/LM Studio 로컬, 공식 Codex/Claude CLI를 등록하고 모델을 나중에도 즉시 변경
- 🛡️ **4단계 권한** — 읽기 전용·변경 전 승인·지정 폴더 자동·전체 허용, 페어링 토큰 인증, PIN 교환 rate-limit
- 🎨 **다크 글래스모피즘 UI** — 데스크톱 창·브라우저·폰 공용
- 📁 **대화별 작업 폴더** — 폴더를 고른 뒤 Codex/Claude Code가 그 폴더에서 네이티브 에이전트로 직접 작업
- 🎙️ **PC 음성 호출·명령** — 설정 가능한 `로봇` 호출어, 로컬 고정확도 한국어 인식과 사용자 지정 응답 음성. 모바일은 안정적인 텍스트·파일 제어에 집중
- 📤 **토큰 없는 파일 전송·동기화** — 공유함·작업 폴더 스트리밍, PC 간 90초 1회성 권한, 기기별 동기화 권한, 충돌 복사본 보존, 취소·부분파일 자동 정리
- ☁️ **VPN 없는 Quick Link** — 선택형 Cloudflare HTTPS/WSS 임시 연결, Tailscale은 기본 OFF 선택 플러그인
- 📌 **상용 앱형 대화 UX** — 대화 고정/고정 우선 정렬, 우클릭 이름 변경·보관·삭제, 다중 파일 드래그앤드롭
- 🔐 **대화별 액세스** — 모델·시나리오·작업 폴더 옆에서 읽기/승인/폴더/전체 권한을 바로 선택하고 대화에 저장
- 📅 **캘린더 플러그인** — 로컬 일정 추가·삭제·목록·ICS 내보내기와 예약 실행을 한 화면에서 관리
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

결과는 `release/Mr.Robot-Setup-0.3.0-x64.exe`입니다. 현재 빌드는 개발용 미서명 설치 파일이므로 조직의 Windows 애플리케이션 제어 정책에서 차단될 수 있습니다. 공개 배포본에는 코드 서명 인증서를 적용해야 합니다.

설치 후 처음 실행하면 **외부 도구 및 의존성 마법사 v4**가 열립니다. 모든 항목을 실제 실행 파일로 검사하고, 기본 에이전트에 필요한 Node.js LTS·Git과 요청된 PC 음성/Codex/Claude 도구만 누락 시 자동 설치합니다. Cloudflare Quick Link, Tailscale, Docker, Orca, Ollama는 선택 플러그인·기능이므로 사용자가 고를 때만 설치합니다. 완료 후에도 설정 → 외부 도구에서 다시 검사하거나 설치할 수 있습니다. Codex·Claude 계정 로그인은 자격 증명을 앱에 복사하지 않고 각 공식 CLI에서 직접 진행합니다.

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
3. 하단 탭에서 **대화 / 예약 / 설정** 전환. 대화 상단에서 여러 대화와 추론 강도 선택
4. PC 여러 대 등록 가능 — 상단 `PC 전환` 버튼으로 전환

완성 APK는 `release/mobile/Mr.Robot-Mobile-0.3.0.apk`입니다. 휴대폰에 VPN을 켜지 않으려면 PC의 Cloudflare Quick Link를 시작한 뒤 HTTPS 주소/QR을 사용합니다. 이미 Tailscale을 쓰는 경우에는 해당 사설 주소도 사용할 수 있습니다. 일반 HTTP Wi-Fi/LAN 주소로 인증정보를 보내는 연결은 차단됩니다.

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

설정 → 모델 라우팅에서 LangChain식 캔버스에 입력·분류·모델·검증·메모리·응답 노드를 자유 배치하고 연결합니다. 절약·균형·품질·코딩 기본 의사결정 트리를 고르거나 현재 트리를 사용자 프리셋으로 저장해 목록에서 다시 적용할 수 있습니다. 모델 노드의 역할과 제공자를 선택하면 그래프 순서가 실제 역할별 우선순위가 됩니다. 대화에서 특정 모델을 고르면 자동 라우팅보다 우선하며, 추론 강도는 자동/없음/낮음/보통/높음/매우 높음/최대 중 지원 값으로 적용됩니다. 같은 화면에서 토큰·도구 호출·실패·지연·예상 비용 통계를 확인합니다.

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

플러그인 탭에서 경로로 불러오기/제거. 예제:

```
examples/plugins/hello    — 명령 등록 예제
examples/plugins/monitor  — 이벤트 구독 + 타이머 예제
```

플러그인은 JS 모듈입니다 (`index.js`/`.mjs`/`.cjs`):

```js
export const plugin = {
  manifest: { id: 'my-plugin', name: 'My Plugin', version: '1.0.0', description: '…' },
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

**누수 없는 이유**: 플러그인이 `ctx`를 통해 만든 모든 리소스(이벤트 구독·타이머·명령)를 관리자가 추적하고, 언로드 시 ①`deactivate()` 호출 → ②구독 해제 → ③타이머 해제 → ④명령 제거 → ⑤모듈 캐시 제거 → ⑥참조 해제 순서로 결정적으로 정리합니다. ESM 모듈은 파일 mtime 기반 캐시라서 같은 파일의 재로드는 모듈 맵에 아무것도 쌓지 않습니다(누수 테스트로 검증). 단, **모듈 스코프 변수는 파일 수정 전까지 유지**되므로 로드마다 초기화되는 상태는 `ctx`(storage 등)에 두세요.

누수 검증은 `npm run test:leak` — 플러그인 600회·WS 80회·스트리밍 20회 반복 후 힙이 수렴하는지 측정합니다.

## 보안

- 기본은 **이 PC 전용(loopback)** 이며, 원격 연결은 HTTPS Quick Link 또는 Tailscale 암호화 주소만 허용합니다.
- 새 QR에는 관리자 시크릿이 없습니다. 5분 만료·1회용 PIN을 교환하면 해시로만 저장되는 **기기별 폐기 가능 토큰**을 발급하고 PIN은 즉시 회전합니다.
- 각 기기는 읽기 전용/승인/작업 폴더/전체 권한 상한을 별도로 가지며, PC에서 한 기기만 즉시 연결 해제할 수 있습니다.
- PIN 교환은 클라이언트별 5분 5회, 전체 5분 50회로 제한되며 새 PIN 발급 시 새 등록 구간으로 초기화됩니다
- 직접 PC 조작 RPC는 `전체 허용` 모드가 아니면 차단되고, 일반 작업은 에이전트 도구 권한 정책을 통과
- 외부 접속은 기본 OFF인 Cloudflare Quick Link 또는 선택형 Tailscale 플러그인을 사용하며, 어떤 전송에서도 기기별 토큰 인증은 유지됩니다
- `~/.mr-robot/` 에 설정·대화·기억·예약·라우팅 통계가 저장됩니다. API 키 값은 Windows 사용자 계정에 묶인 DPAPI 암호문으로만 기록됩니다.

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
- **폰에서 접속 불가**: PC 플러그인에서 Quick Link가 실행 중인지 확인하고 새 HTTPS QR을 등록하세요. Tailscale을 선택했다면 두 기기가 같은 tailnet에 있고 PC의 사설 Mesh 수신이 켜졌는지 확인하세요.
- **예전에 등록한 `192.168.x.x` 주소가 안 될 때**: 평문 LAN 인증은 보안을 위해 차단되었습니다. 해당 PC 등록을 지우고 Quick Link HTTPS 또는 Tailscale 주소로 다시 등록하세요.
- **Expo 버전 조정**: `cd apps/mobile && npx expo install --fix`
