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
- Android 음성은 [Android foreground service/microphone 제한](https://developer.android.com/develop/background-work/services/fgs/service-types)을
  따라 화면/포그라운드 중심으로 구현했습니다. 불명확한 모델 라이선스가 있는 wake-word
  가중치는 번들하지 않았습니다.
- 캘린더는 로컬/ICS를 완성 경계로 두었습니다. Google 연결은
  [Calendar events.insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)와
  OAuth consent를 따를 adapter 자리만 유지하며 공용 client secret을 내장하지 않습니다.

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

2026-08-23 감사에서 직접 의존성은 MIT/Apache/BSD/ISC 계열로 확인됐고, 전이 의존성
`node-forge`가 `(BSD-3-Clause OR GPL-2.0)` 이중 라이선스로 탐지됐습니다. 배포 시
BSD-3-Clause 선택 조건과 고지를 적용해야 하며 GPL-only 코드로 분류하지 않습니다.
