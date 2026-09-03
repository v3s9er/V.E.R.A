# 연구·오픈소스·라이선스 근거

## 적용한 설계 근거

- [FrugalGPT](https://arxiv.org/abs/2305.05176)의 cascade 관점을 `스마트 캐스케이드`에
  적용했습니다. 싼 모델의 confidence/검증 결과가 충분할 때는 고비용 호출을 생략합니다.
- [RouteLLM](https://arxiv.org/abs/2406.18665)의 strong/weak routing과 cost-quality
  threshold를 참고해 역할, 비용 등급, 복잡도, 로컬 telemetry가 분리된 라우터 계약을
  유지했습니다. 현재 기본값은 해석 가능한 규칙이며 사용자 데이터로 몰래 학습하지 않습니다.
- [ReConcile](https://arxiv.org/abs/2309.13007)의 round-based discussion 및 confidence
  weighted consensus, [PoLL](https://arxiv.org/abs/2404.18796)의 다양한 소형 judge panel
  관점을 회의/투표/검증 프리셋에 적용했습니다. 같은 모델을 단순 복제하지 않고 제공자·역할
  다양성이 있을 때만 투표의 이득을 기대하도록 설계했습니다.
- [OpenHands Agent SDK](https://github.com/All-Hands-AI/agent-sdk)와
  [agent-debate](https://github.com/Skytliang/Multi-Agents-Debate)을 기능 비교 대상으로
  검토했습니다. 외부 코드를 복사하지 않았고 Mr.Robot의 타입/실행/저장 계약에 맞춰
  독립 구현했습니다.

여러 모델을 항상 부르면 품질이 자동으로 오르지 않고 토큰도 각자 소비합니다. 따라서 기본
단일 모드는 Codex/Claude Code의 완성된 네이티브 루프를 그대로 쓰고, 복합 프리셋은 위험도·
불확실성·검증 가치가 있는 작업에서만 선택합니다. 로컬 context broker는 파일 파싱/전달을
재사용하지만 공급자 간 청구 토큰을 공짜로 공유한다고 표시하지 않습니다.

## 프로토콜과 보안 근거

- MCP는 [공식 TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)와
  [MCP 보안 모범 사례](https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices)를
  기준으로 stdio transport, 지연 연결, 명시적 사용자 승인, 도구 설명 비신뢰 원칙을 적용했습니다.
  직접 의존하는 SDK는 MIT 라이선스입니다.
- Docker 실행은 [리소스 제한](https://docs.docker.com/engine/containers/resource_constraints/),
  [기본 seccomp](https://docs.docker.com/engine/security/seccomp/),
  [rootless 보안 모델](https://docs.docker.com/engine/security/rootless/)을 참고했습니다.
  실제 플러그인은 rootless 여부와 무관하게 non-root user, capability drop, no-new-privileges,
  no-network, read-only root, resource cap을 중첩합니다.
- 외부 파일 연결은 [Tailscale Taildrop의 peer-to-peer 전송 설명](https://tailscale.com/kb/1106/taildrop)을
  참고했지만 Taildrop API에 종속하지 않습니다. Tailscale은 IP transport이고 실제 전송 권한과
  파일 API는 Mr.Robot이 소유합니다.
- VPN 없는 선택 연결은 [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)의
  임시 HTTPS 경로를 사용합니다. 개발·테스트용 임시 주소라는 공급자 경계를 UI에 표시하고,
  기본 설치·실행·자동 시작은 모두 끈 상태로 둡니다. 파일·상태 전송은 별도의 90초 1회성
  capability를 사용해 대상 PC에 소스 PC 장기 토큰을 전달하지 않습니다.
- Android의 [foreground service/microphone 제한](https://developer.android.com/develop/background-work/services/fgs/service-types)과
  OEM별 백그라운드 정책을 검토한 결과, 모바일 음성 상시 대기는 제거했습니다. 음성 호출은
  PC의 로컬 인식 플러그인에서만 동작하고 모바일은 텍스트·파일·승인 제어에 집중합니다.
  불명확한 라이선스의 wake-word 가중치는 번들하지 않았습니다.
- 캘린더는 로컬/ICS를 완성 경계로 두었습니다. Google 연결은
  [Calendar events.insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)와
  OAuth consent를 따를 adapter 자리만 유지하며 공용 client secret을 내장하지 않습니다.
- 허가된 웹 클라이언트 진단은 [Chrome DevTools Protocol의 초기 문서 스크립트](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-addScriptToEvaluateOnNewDocument),
  [런타임 binding](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-addBinding),
  [child target 자동 연결](https://chromedevtools.github.io/devtools-protocol/tot/Target/#method-setAutoAttach)과
  [MDN SubtleCrypto](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto)의 공개 계약을 기준으로 독립 구현했습니다.
  Chrome/Edge나 자동화 도구의 소스를 포함하지 않고 설치된 시스템 브라우저를 격리된 임시 프로필로 실행합니다.
- 독립 도구 포털의 비밀번호·세션 경계는 [OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html),
  [Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html),
  [Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) 지침과
  [Node.js `crypto.scrypt`](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback)의 공개 API를 적용했습니다.
  비밀번호 원문이나 장기 browser bearer를 파일에 저장하지 않으며 포털 세션은 서버 메모리에만 유지합니다.

## 뒤탈 방지 원칙

1. 논문에서 아이디어와 평가 관점만 참고하고 논문 구현 코드를 복사하지 않았습니다.
2. 검토한 GitHub 저장소 코드를 vendor하지 않았습니다. 실제 런타임 의존성은 npm lockfile과
   `scripts/licenses.mjs`로 확인합니다.
3. 불명확한 음성 모델, CTF 이미지 바이너리, 상용 API 자격 증명을 배포물에 포함하지 않습니다.
4. Dockerfile은 Ubuntu 공식 패키지와 PyPI 패키지를 설치해 로컬 이미지를 사용자가 재생성합니다.
   개별 도구 라이선스는 컨테이너의 패키지 metadata/license 파일을 따릅니다.
5. 제공된 개인 API 키/페어링 비밀을 문서·테스트·압축 파일명에 다시 기록하지 않습니다.

`node scripts/licenses.mjs`를 릴리스 전에 실행해 직접 의존성 라이선스와 copyleft 후보를
검사합니다. 이는 법률 자문이 아니며 공개 상용 배포 전에는 최종 SBOM/NOTICE와 코드 서명,
각 공급자 이용약관 검토가 필요합니다.

2026-08-31 최종 감사에서 직접 런타임 의존성은 MIT/Apache/BSD/ISC 계열로 확인됐습니다.
브랜드 PNG 생성에만 쓰는 개발 의존성 Sharp의 사전 빌드 libvips 패키지는 LGPL-3.0-or-later를
함께 표시하므로 결정적 NOTICE에 해당 고지를 포함했습니다. Sharp/libvips 바이너리는 Electron
stage와 APK에는 들어가지 않고 생성된 이미지 자산만 배포됩니다. 공개 상용 배포 전에는 이
NOTICE와 실제 패키지 내용을 다시 대조해야 합니다.
