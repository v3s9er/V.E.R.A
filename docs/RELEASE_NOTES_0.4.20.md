# 0.4.20 — Conversation-scoped native sessions

이번 릴리스는 PC 설치 마법사(EXE), Android APK, 소스 ZIP, SHA-256 체크섬을 제공합니다.
Android는 실제 버전 `0.4.20` / versionCode `25`로 빌드하며 기존 공식 서명 ID를 유지합니다.
기존 모바일 APK도 업데이트된 PC와 호환되며, APK 설치가 필수인 통신 규격 변경은 없습니다.

## 이전 공개 릴리스 0.4.14 이후 누적 변경

- **Discord 권한 분리 (0.4.15–0.4.16):** `allow_ai`는 티켓 이용 권한이며 PC 관리 권한과 분리됩니다. 일반 사용자는 소유자의 공급자·기본 모델을 사용하되 공개 웹 검색과 본인 티켓의 격리 작업·결과물만 이용합니다. 관리자별/사용자별 정책과 모델 상한을 유지하고, 역할 변경 시 실행·전달 권한을 재검사합니다. 초기 0.4.15의 API 전용 제한은 0.4.16에서 제거되었습니다.
- **첨부파일 수신 (0.4.17):** 여러 파일과 파일만 보낸 메시지를 처리합니다. PDF·Office·ODF·HWP/HWPX·XLS·RTF·텍스트·ZIP·이미지 OCR을 지원하며, 읽지 못한 형식은 내용을 추측하지 않고 부분 인식/읽기 불가로 알립니다. 모든 확장자의 수신이 모든 형식의 완전한 해석을 의미하지는 않습니다.
- **티켓 복구·공정 실행 (0.4.18):** Discord 재연결 상태 복구, 사용자별 순차 대기열과 최대 두 개의 격리 작업 병렬 처리, 전체 PC 작업의 독점 실행을 적용했습니다. 일반 새 메시지는 대기열에 넣고, `지시 추가`로 실행 중 작업에 명시적으로 개입합니다. 불확실한 실행은 자동 재실행하지 않습니다.
- **응답 전달·효율 (0.4.18):** 진행 메시지를 같은 자리의 최종 답변으로 교체하고, 긴 답변은 분할 미리보기와 전체 TXT로 제공합니다. 격리 Codex 프로세스와 문서 분석 결과를 제한된 범위에서 재사용하며 사용자·티켓·권한 경계를 유지합니다.
- **원본 문서·샌드박스 (0.4.19):** Discord 원본을 티켓별로 암호화해 최대 7일 보관하고 재사용 가능한 오프라인 Linux 컨테이너에서 읽습니다. PDF 페이지 범위 읽기와 한글/영문 OCR, 재시작 후 원본 재열기를 지원합니다. 관리자는 기존 WSL Docker 엔진을 선택할 수 있습니다. Discord 자체 전송은 E2EE가 아닙니다.
- **라이선스:** Mr.Robot 및 Discord 통합 코드에 MIT 라이선스를 적용했습니다. 외부 구성요소의 고지와 라이선스는 별도로 유지하며, AI 공급자의 구독 이용약관을 대체하지 않습니다.
- **배포 보안 검사:** 공개 소스·도달 가능한 Git 이력·이전 릴리스 자산 72개와 이번 배포 파일을 검사했습니다. 알려진 인증정보 형식과 민감 경로 기준으로 실제 사용자 비밀정보는 발견되지 않았습니다. 과거 의존성에 포함된 공개 Zod 테스트 JWT는 원본과 지문을 대조했습니다. 미지의/별도 인코딩된 비밀정보까지 부재를 보장하는 검사는 아니며 Git 이력은 삭제하지 않았습니다.

아래는 0.4.20에서 추가된 세션 유지·진행 표시의 세부 변경입니다.

## Execution

- PC, mobile and administrator Discord Codex requests with a selected workspace now share the same conversation-scoped app-server adapter instead of starting an ephemeral `codex exec` task on every turn.
- Follow-ups send only new input and changed retained context. The provider retains earlier conversation/tool state. A host-verified transcript mismatch, changed provider/model/workspace/permission or different conversation creates a separate session.
- Up to four native workers stay warm, and idle workers close after five minutes. Local checkpoints allow exact-thread resume after idle eviction or app restart. They contain thread IDs, transcript hashes and usage counters, not credentials or duplicate conversation text. Checkpoints are bounded to 128 entries and seven days. Provider rollout retention remains governed by the user's Codex installation.
- Failed/cancelled turns invalidate the resume checkpoint; no uncertain side-effecting turn is automatically replayed. Failed resume before a turn starts can recover from Mr.Robot history.
- Usage accounting subtracts prior cumulative totals, including after resume. User-selected model and reasoning effort are preserved.
- Codex chat without a selected workspace uses the existing bounded text-only worker pool. Restricted Discord remains on the separate broker-only path: this update does not grant native host access to ordinary users.
- Conversation/status questions no longer receive unconditional coding-task instructions. Attachment inventories no longer tell the model to re-read originals on every follow-up.

## Progress

- Public task status, native tool activity and final-answer streaming are surfaced without exposing private reasoning.
- Native and Discord progress have periodic elapsed-time updates. Discord coalesces in-flight updates to the latest state instead of dropping them; update failures log only the exception type.

## Verification

- Synthetic process tests cover warm reuse, persisted resume, incremental input, usage deltas, identity/authority/history invalidation, approval rejection and cancellation.
- Installed Codex integration test uses a localhost synthetic Responses server and a temporary CLI home, not a paid model/account. Verifies three turns including process restart, retained conversation, high reasoning and per-turn usage. This is transport overhead testing, not a production model latency guarantee.
- Python Discord delivery test verifies latest-progress coalescing and cleanup. Existing authorization, attachment, sandbox, provider security and orchestration regression suites are retained.

The mobile client protocol is unchanged; existing APKs receive the improved execution through their connected updated PC. Claude and API providers retain their existing transport; shared intent/attachment instructions also improve those paths.

Reference: [Official Codex app-server lifecycle and thread resume](https://learn.chatgpt.com/docs/app-server).
