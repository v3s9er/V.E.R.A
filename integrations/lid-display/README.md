# 덮개 · 외부 화면 (Windows 11)

Mr.Robot의 독립적인 선택형 플러그인입니다. Discord나 다른 봇에 의존하지 않습니다.
플러그인 → 시스템 → **덮개 · 외부 화면 → 켜기**. 설치 기본값은 꺼짐입니다.
PC 앱이 켜져 있는 동안 동작하며, 플러그인 활성화 여부는 앱 재실행 후에도 유지됩니다.

- Windows 전원 설정의 **덮개를 닫을 때: 아무것도 안 함**은 사용자가 유지해야 합니다.
- 열림을 한 번 확인한 뒤 닫으면 외부 디스플레이 출력 경로를 해제합니다. PC/에이전트 작업은 계속됩니다.
- 열면 기존 화면 구성을 복원합니다. 정상적인 플러그인 해제·앱 종료와 부모 프로세스 종료 시에도 복원을 시도합니다.
- **지금 화면 복구**를 누르면 닫혀 있어도 복구하며, 다음 열림→닫힘부터 다시 작동합니다.
- 케이블/도크가 바뀌어 원래 배치를 적용할 수 없으면 Windows의 현재 연결 장치 구성으로 복구합니다.
- 비정상 전원 차단 시 복원 상태는 사용자 로컬 데이터 폴더에 남아 다음 플러그인 시작 때 복구합니다.
- 내장 패널과 로컬 Windows 콘솔 세션이 필요합니다. 닫힌 패널 출력을 허용하지 않는 드라이버에서는 지원되지 않을 수 있습니다. 이 경우 오류를 표시하고 복구합니다.
- 물리적인 케이블 제거, 모니터 전원 차단, USB 허브 연결 해제가 아닙니다. HDMI/DP 오디오는 화면 경로와 함께 해제될 수 있습니다.
- 화면 복구 실패 시 덮개를 열고 **Win+P → 확장**을 사용하세요. 절전·최대절전·잠금·전원 계획은 변경하지 않습니다.

## 구현과 안전성

Windows PowerShell의 고정된 로컬 헬퍼를 숨김 실행합니다. 관리자 승격·서비스 설치·예약 작업·네트워크 요청·AI 호출은 없습니다.
명령은 로컬 관리자 UI 전용이며 AI/Discord 도구로 노출하지 않습니다.
상태 이벤트는 `RegisterPowerSettingNotification`의 `GUID_LIDSWITCH_STATE_CHANGE`로 받습니다.
`QueryDisplayConfig`로 배치를 보관하고 `SetDisplayConfig`의 임시 구성만 적용합니다(`SDC_SAVE_TO_DATABASE` 미사용).
감지 핸들, 프로세스, 타이머는 종료 때 정리합니다. 중복 헬퍼는 세션 단위 뮤텍스로 방지합니다.
코드는 이 저장소의 MIT 라이선스를 따릅니다. 개인 화면 배치와 설정 파일은 배포하지 않습니다.

참조: [덮개 상태 알림](https://learn.microsoft.com/en-us/windows/win32/power/power-setting-guids),
[화면 구성 적용](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setdisplayconfig).

## 검증

`powershell.exe -NoProfile -NonInteractive -Sta -File integrations/lid-display/bridge.ps1 -Probe`
는 컴파일 및 내장/외부 화면 존재 여부만 확인하며 화면은 바꾸지 않습니다.
실제 닫힘→외부 화면 해제→열림→복원은 노트북 하드웨어에서 별도로 확인해야 합니다.
