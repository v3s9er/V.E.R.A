# 대회 문제 기반 회귀 검사

검사기는 Mr.Robot의 실제 `AgentLoop`와 격리된 Codex 구독 전송 경로를 사용한다. 공식 대회 참가·리더보드 제출·앱 전체 성능 평가가 아닌, 조건을 고정한 자체 회귀 검사다. 앱의 기본 모델·권한·프로필이나 사용자의 대화는 변경하지 않는다.

실제 실행 집계는 [2026-10-02 결과](COMPETITION_RESULTS_2026-10-02.md)에 기록한다.

## AIME: 고정된 정답으로 확인하는 수학 추론

[AIMO 공개 검증 데이터](https://huggingface.co/datasets/AI-MO/aimo-validation-aime)의 2022~2024년 AIME I·II 문제를 사용한다. 실행할 연도를 정하면 I 15개, II 15개 **30문항 전부**를 고정 순서로 푼다. 잘 맞힌 문항만 선택하거나 실패 문항을 분모에서 빼지 않는다.

- 데이터셋: `AI-MO/aimo-validation-aime`
- 고정 리비전: `13f9e12f613e720c2a2b2f345dd04b998a29494d`
- 원본 Parquet SHA-256: `025484a99fea498e7d0c3b0ee42afcbec0176405c19c5dbf557b9f6ca6445675`
- 변환 캐시 SHA-256: `24e50dcd3ba120e4eb0f605bb03bf778f5dc5d6ace59ebb0ed106be943c67838`
- 출처 카드의 선언 라이선스: Apache-2.0. 이는 데이터셋 유지관리자의 선언이며, 별도 원출처 자료의 권리까지 확대 해석하지 않는다. 문제·정답·해설 파일은 공개 저장소에 재배포하지 않는다.

모델 입력에는 문제 본문만 제공한다. 참조 정답·해설·출처 URL은 입력하지 않고, 검색·PC 파일·셸·개인 메모리·기존 대화도 제공하지 않는다. 평가 전용 경로에서 사용자가 선택한 정확한 모델의 제공 여부를 먼저 확인하며, 이용 불가를 오답으로 기록하거나 다른 모델로 대체하지 않는다. Daybreak는 이 수학 검사에서 꺼져 있다.

채점 규칙은 실행 전에 고정한다. 최종 출력 전체가 `Answer: N` 형식이고 N이 0~999인 정수이며 참조 정답과 같아야 통과한다. 앞쪽 0은 허용하지만 후보 여러 개, JSON, 수식, 설명 속 정답 부분 일치는 허용하지 않는다. 형식 오류도 실패다. 정답 숫자를 생성했는지 검사하는 것으로 풀이 과정의 타당성까지 증명하지는 않는다.

각 문항은 새 CLI·새 세션에서 1회 실행한다. 기본 제한은 120초, 동시 실행은 1개, 재시도는 없다. 시간 초과는 분모에 남기고 다음 문제로 진행한다. 인증·전송·실행 불변식 오류는 추가 소비를 중단하며 미실행 문항 수를 별도로 표시한다. 실행 중 관련 소스의 해시가 바뀌면 비교 가능한 결과로 취급하지 않는다.

정답 수/전체 수, 완료 수, 실패 종류, 실제 추론 단계, 첫 텍스트·완료 시간 p50/p95, 보고된 토큰을 기록한다. 제공되지 않은 토큰 수는 0이 아닌 미상으로 보존한다. 완료 시간은 세션을 재사용하는 평소 대화의 지연과 직접 비교할 수 없다.

### 재현

Node 의존성과 `npm run build:shared`가 준비된 저장소 루트에서 실행한다. Python 3.12와 `pyarrow==21.0.0`은 데이터 준비에만 필요하다. 아래 설치는 전역 Python 환경이 아니라 Git에서 제외된 평가 폴더에 한정한다.

```powershell
python -m pip install --target release/validation/aime-tools pyarrow==21.0.0
$previousPythonPath = $env:PYTHONPATH
try {
  $env:PYTHONPATH = (Resolve-Path -LiteralPath 'release/validation/aime-tools').Path
  python scripts/benchmark-aime-prepare.py --out release/validation/aime-pinned.json
} finally { $env:PYTHONPATH = $previousPythonPath }

npm run test:benchmarks
npm run benchmark:aime -- --help
# 기존 구독 사용량을 사용하는 단계. 모델/추론/출력 경로를 명시한다.
npm run benchmark:aime -- --cache release/validation/aime-pinned.json --year 2024 --model gpt-6-sol --effort auto --allow-account-usage yes --timeout-ms 120000 --out-prefix release/validation/aime2024-run-001
```

캐시가 이미 존재하면 준비 명령은 덮어쓰지 않고 중단한다. 검증된 기존 캐시는 재사용한다. 실행 결과도 기존 접두사에 덮어쓰지 않으므로 새 실행마다 새 `--out-prefix`를 선택한다. Windows에서 `python`이 Store 별칭이면 실제 설치된 Python 실행 파일의 전체 경로를 사용한다.

결과는 `.manifest.json`, `.progress.jsonl`, `.report.json`으로 저장한다. 실행 중간 결과가 남고 참조 정답·원문 응답·개인 경로·인증정보는 결과에 싣지 않는다. 데이터 캐시와 원본 결과는 `release/validation/`에 보관하여 Git에서 제외한다. 공개 보고서는 검토된 집계치만 담는다. 원시 결과에는 예측 정수가 있으므로 캐시와 함께 별도 취급한다.

## 해석과 개선 원칙

- 공개 AIME 문제가 모델의 사전 학습에 포함되지 않았음을 보장하지 않는다. 다른 연도를 새로 실행해도 이는 이번 튜닝에서 미사용한 평가일 뿐, 모델 학습과의 독립성을 보장하는 비공개 시험은 아니다.
- 30문항의 Wilson 95% 구간은 문항 표본에 대한 참고치다. 서로 다른 날의 모델 변동·반복 실행 변동이나 모든 업무의 정확도를 나타내지 않는다.
- 재시도·프롬프트 변경 후의 성적은 별도 실험으로 기록한다. 최초 점수와 합치거나 가장 좋은 응답만 골라 pass@1이라고 부르지 않는다.
- 속도·정확도 향상 주장은 같은 문제·모델·조건의 기준/후보 비교와 별도의 미사용 평가로 확인해야 한다. 이 검사기는 평가 결과를 보고 프로덕션 설정을 자동으로 승격하지 않는다.
- 수학 검사에 더해 [BFCL 도구 호출 검사](external-agent-benchmarks.md)가 있다. 이 둘만으로 Discord 첨부·모바일 UI·컴퓨터 조작·장기 기억이 검증됐다고 주장하지 않는다.

과제별 목표, 고정 평가 기준, 지속적인 회귀 검사는 [OpenAI의 평가 지침](https://developers.openai.com/api/docs/guides/evaluation-best-practices)을 참고했다.

## AI TOP 100: 확인한 범위와 아직 없는 재현 자료

2026-10-02에 확인한 카카오 원문에는 [PDF의 숨겨진 텍스트](https://brunch.co.kr/@andkakao/322), [규칙 기반 입국 심사](https://brunch.co.kr/@andkakao/327), [코드 이미지 해석](https://brunch.co.kr/@andkakao/317), [영상 사실 확인](https://brunch.co.kr/@andkakao/324) 등의 유형이 있다. 따라서 추론 모델만이 아니라 첨부 원본 전달, 이미지·영상 관측, 규칙 우선순위, 출력 정합성이 필요하다.

확인한 소개 페이지에서는 숨겨진 텍스트 PDF 원본, 전체 입국 규칙·지원자 자료와 공식 정답을 확보하지 못했다. 과거 문제 허브 주소는 현재 대회 안내 페이지로 연결된다. **AI TOP 100 원문 전체를 실행하거나 공식 점수를 받았다고 표시하지 않는다.** 소개를 보고 만든 유사 문제는 별도의 합성 회귀 검사로 표기해야 하며 원문 대회 점수에 섞지 않는다. 원본 입력·채점 기준·이용 조건을 확인한 유형부터 확장한다.
