# Mr.Robot Mobile

Mr.Robot PC 에이전트용 React Native(Expo) 앱.

## 실행

```bash
npm install
npx expo start        # Expo Go로 QR 스캔 (같은 Wi-Fi)
npx expo run:android  # 네이티브 빌드
```

## PC 연결

1. PC에서 Mr.Robot 에이전트 실행 (웹 UI의 설정 → 모바일 연결 탭)
2. 앱에서 `QR 코드 스캔` (PC 화면의 QR) 또는 `PIN으로 PC 추가`
3. PC 여러 대 등록 가능 — 상단 `PC 전환`으로 전환
4. 하단 탭: 대화 / 원격제어 / 예약 / 설정

## 주의

- PC와 폰이 같은 네트워크(Wi-Fi)에 있어야 합니다.
- Expo SDK 57 / React Native 0.86 기준입니다. `npx expo install --check`와 `npx expo-doctor`로 호환성을 확인할 수 있습니다.
