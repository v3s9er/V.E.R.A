# 외부 에이전트 벤치마크와 반복 개선

검토일: 2026-09-23. 이 문서는 평가 설계와 재현 조건이며, 실행 성공이나 점수 향상을 선언하는 결과표가 아니다.

## 무엇을 평가하는가

V.E.R.A의 처리 속도, 모델의 도구 선택 정확도, 실제 브라우저·데스크톱 작업 성공률은 서로 다른 지표다.
공개 순위표의 모델 점수를 V.E.R.A의 점수로 가져오지 않는다. 모델·프롬프트·실행 환경·채점기를 명시한 자체 실행이 필요하다.
기존 [성능 평가](performance-evaluation.md)의 지연·토큰 측정에 외부 공개 문제를 추가한다.

2026-10-02 추가: [대회 문제 회귀 검사](competition-evaluation.md)는 AIME 연도별 I·II 30문항의 고정 정답을 실제 AgentLoop 경로에서 확인한다. BFCL과 다른 능력을 측정하며 공식 대회 점수로 합산하지 않는다.

| 벤치마크 | 측정 대상 | 이번 적용 범위 / 필요한 환경 |
| --- | --- | --- |
| [BFCL V4](https://gorilla.cs.berkeley.edu/leaderboard.html) | 도구 선택, 인자, 병렬 호출, 다중 턴, 메모리 | 공개 단일 턴 4개 범주만 사용. 실제 기능은 실행하지 않고 호출을 기록·채점한다. |
| [SWE-bench](https://www.swebench.com/SWE-bench/guides/quickstart/) | 실제 저장소의 버그 수정과 테스트 통과 | 별도 Linux 컨테이너·테스트 환경이 필요하다. 이번에 설치하거나 실행하지 않는다. |
| [OSWorld](https://github.com/xlang-ai/OSWorld) | 데스크톱·파일·여러 앱을 아우르는 업무 | 별도 VM·초기 상태·스크린샷·결과 검사기가 필요하다. 사용자 PC를 평가 대상으로 사용하지 않는다. |
| [WebArena](https://github.com/web-arena-x/webarena) / [BrowserGym](https://github.com/ServiceNow/BrowserGym) | 브라우저에서 실제 업무 완수 | 자체 호스팅 시험 사이트·Playwright·초기화가 필요하다. 공개 데모는 재현 평가용이 아니다. |
| [GAIA](https://huggingface.co/datasets/gaia-benchmark/GAIA/blob/main/README.md) | 검색·문서·멀티모달 종합 문제 해결 | 데이터 접근 동의와 첨부 처리 등이 필요하다. 문제를 공개 Git에 재배포하지 않는다. |
| [τ-bench](https://github.com/sierra-research/tau2-bench) | 고객 대화, 업무 정책, 도구와 상태 변경 | 현행 환경은 Python 3.12 이상·3.14 미만, uv와 사용자 시뮬레이터 모델 등이 필요하다. 이번 범위 밖이다. |

OSWorld의 VM 및 WebArena의 시험 사이트는 모델의 잘못된 조작도 격리할 수 있도록 준비해야 한다.
Docker/VM 사용 자체가 안전 보증은 아니다. 사용자 폴더·인증정보를 마운트하지 않고, 외부 통신·자원·수명도 제한해야 한다.

## 첫 평가: BFCL 공개 부분집합

[공식 리더보드](https://gorilla.cs.berkeley.edu/leaderboard.html)가 명시한 재현 기준은 다음과 같다.

- 저장소: `ShishirPatil/gorilla`
- 고정 커밋: `f7cf7359b7ac615a0b294831c5ba2bc95ee4a000`
- 공식 패키지 대응 버전: `bfcl-eval==2025.12.17` — 이번 자체 실행기는 이 패키지를 자동 설치하지 않는다.
- 범주: `simple_python`, `multiple`, `parallel`, `irrelevance`
- 문제 형식: 공식 JSONL의 `question`과 `function`. 정답은 모델 입력에 포함하지 않는다.
- 공식 문제·정답 파일은 저장소에 복사해 배포하지 않는다. 고정 출처에서 별도 캐시에 내려받고 해시를 기록한다.

[문제 예시 파일](https://raw.githubusercontent.com/ShishirPatil/gorilla/f7cf7359b7ac615a0b294831c5ba2bc95ee4a000/berkeley-function-call-leaderboard/bfcl_eval/data/BFCL_v4_simple_python.json)과
[정답 예시 파일](https://raw.githubusercontent.com/ShishirPatil/gorilla/f7cf7359b7ac615a0b294831c5ba2bc95ee4a000/berkeley-function-call-leaderboard/bfcl_eval/data/possible_answer/BFCL_v4_simple_python.json)을 분리해 읽는다.
그 밖의 파일도 같은 커밋과 범주별 경로를 사용하며, 최신 `main`으로 조용히 바꾸지 않는다.

## 고정 비교 계획

| 항목 | 계획 |
| --- | --- |
| 개발용 문제 | 범주별 10개, 총 40개 |
| 보류 평가 문제 | 개발용과 겹치지 않는 범주별 10개, 총 40개 |
| 선택 방법 | 고정 seed·범주·문항 ID에 대한 SHA 기반 결정적 순서, 분할 목록과 해시 기록 |
| 기준 설정 | `gpt-5.6-terra`, 추론 `medium` |
| 후보 설정 | 같은 모델, 추론 `low` |
| 나머지 조건 | 같은 기본 지시, 문제, 도구 명세, 시간 제한, 채점 규칙 |
| 동시 실행 | 1개. 같은 문제의 기준/후보 순서는 교차해 시간대 편향을 줄인다. |
| 설정 반영 | 평가 중 실제 앱의 공급자·모델·추론·권한 설정을 자동 변경하지 않는다. |

위 모델명은 이번 비교의 지정값이며, 모든 계정에서 지원된다는 뜻은 아니다. 지원되지 않으면 다른 모델로 몰래 대체하지 않고 실패를 기록한다.
첫 개발 비교에서 low의 P95가 고정 허용 범위를 초과하여 기본값 후보로 채택하지 않았다. 두 번째 개발 실험은 같은 개발 문항·모델·채점기를 유지하고, 새 medium 기준 실행과 high 후보를 교차 비교한다. low 실험의 가장 좋은 기준 측정값만 골라 재사용하지 않는다. 보류 세트는 개발 검토를 통과한 후보가 있을 때만 사용한다.
개발 40문항과 보류 40문항을 준비한 계획이며, 이번 두 실험은 개발 40문항만 각 두 설정으로 실행했다(총 160회 문항·설정 실행). 실제 API/CLI 요청 수와는 다르다. 도구 반환 뒤 이어지는 턴, 오류, 취소를 구분한다.
보류 결과를 보고 프롬프트를 다시 맞췄다면 그 세트는 더 이상 보류 세트가 아니다. 새로 고정한 미사용 문제로 확인해야 한다.
여기서 보류는 이번 튜닝 과정에서 분리했다는 뜻이다. 공개 BFCL 문제가 기초 모델의 과거 학습에 포함되지 않았음을 보증하지는 않는다.

## 실행 및 채점 경계

V.E.R.A의 네이티브 브로커를 거치되, 이 평가의 도구는 호출명·인자를 기록하는 전용 대역이다.
파일 읽기·쓰기, 셸, 실제 웹 요청, 데스크톱 조작, 실제 업무 데이터 변경 기능을 제공하지 않는다.
이 평가 실행기와 채점기는 문제의 함수명이나 호출 인자를 기록·비교하며 자체적으로 `eval`, 셸 명령, 동적 코드로 실행하지 않는다.
네이티브 공급자 세션은 기존 사용자 대화와 분리하고, 개인 문서·메모리·프로젝트 내용을 입력하지 않는다.

채점기는 **V.E.R.A의 엄격한 자체 채점기**다. 공식 BFCL 채점기를 실행한 결과라고 표시하지 않는다.
호출 개수·함수명·인자를 비교하며, 관련 없는 문제에서는 도구를 호출하지 않는지 검사한다.
병렬 범주는 결과 목록 순서와 호출 내용의 일치 여부를 구분한다. 잘못된 형식이나 제한 시간 초과도 전체 분모에 남긴다.
공식 정답의 허용 대안, 생략 표식과 배열 구조를 훼손하지 않으며 정답 문자열을 실행하지 않는다.
[공식 AST 채점기](https://raw.githubusercontent.com/ShishirPatil/gorilla/f7cf7359b7ac615a0b294831c5ba2bc95ee4a000/berkeley-function-call-leaderboard/bfcl_eval/eval_checker/ast_eval/ast_checker.py)의 정규화와 자체 규칙은 차이가 날 수 있다.

따라서 보고서 이름은 **“BFCL V4 공개 부분집합 / V.E.R.A 자체 채점”**으로 한다.
전체 BFCL 순위, 공식 점수, GUI 성능, 장기 기억, 코딩 성공률로 환산하지 않는다.
[공식 실행 안내](https://raw.githubusercontent.com/ShishirPatil/gorilla/main/berkeley-function-call-leaderboard/README.md)도 부분 평가가 전체 리더보드와 다를 수 있다고 명시한다.

## 결과를 보고 개선하는 순서

1. 실행 전에 문제 분할·설정·채점기 버전·승격 조건을 고정하고 기록한다.
2. 개발용 기준/후보를 같은 조건으로 실행한다. 낮은 추론이 더 빠르다고 가정하지 않는다.
3. 전체 및 범주별 정답 수/분모, 실패·시간 초과, 첫 응답·완료시간 p50/p95, 보고된 토큰을 비교한다.
4. 개발 결과에서 후보를 선택한 뒤, 보류 세트로 한 번 확인한다. 점수에 맞춘 사후 제외·재채점은 하지 않는다.
5. 품질 저하·특정 범주 회귀·지연 꼬리 악화가 있으면 속도만 보고 기본값으로 승격하지 않는다.
6. 표본 수와 신뢰구간을 함께 적는다. 40문항의 작은 차이는 일반 성능 향상을 입증하지 않는다.
7. 앱에 반영할 변경은 별도 회귀 테스트와 검토를 거친다. 실험 스크립트는 설정을 자동 승격하지 않는다.

[OpenAI 평가 가이드](https://developers.openai.com/api/docs/guides/evaluation-best-practices)의 원칙처럼 과제별 목표·자동 채점·사람의 검토를 함께 사용한다.
벤치마크 점수만 올리는 대신 실제 사용에서 발견한 일반화 가능한 실패를 별도의 비공개 회귀 테스트로 보완한다.

## 실행 명령

실측 결과와 미채택 이유는 [2026-09-23 결과 요약](BFCL_RESULTS_2026-09-23.md)에 정리했다.

기존 프로젝트 의존성을 설치한 저장소 루트에서 실행한다. 공개 데이터는 임시 캐시에 저장하며 앱 설정은 바꾸지 않는다.

```powershell
npm run benchmark:bfcl -- --help
# 공개 데이터만 내려받는 준비 단계. 모델 사용량을 쓰지 않는다.
$benchCache = Join-Path $env:TEMP 'mrrobot-bfcl-f7cf735'
npm run benchmark:bfcl -- --mode prepare --cache $benchCache --download yes
# 실제 구독 사용량을 쓰는 단계. 기준/후보와 출력 경로를 명시한다.
$benchOutput = Join-Path $env:TEMP 'mrrobot-bfcl-dev-001'
npm run benchmark:bfcl -- --mode run --cache $benchCache --split dev --seed mrrobot-bfcl-v1 --per-category 10 --allow-account-usage yes --model gpt-5.6-terra --baseline-effort medium --candidate-effort low --out-prefix $benchOutput
# 후보를 고정한 뒤 새 출력 경로와 --split holdout으로 보류 평가한다.
npm run test:benchmarks
# 모델 호출 없이 사람이 읽을 결과표를 새 파일로 만든다.
npm run benchmark:report -- --baseline "$benchOutput.baseline.json" --candidate "$benchOutput.candidate.json" --out "$benchOutput.md"
```

실행 결과 보고서는 문항 ID·출처 해시·설정·숫자·실패 유형만 보관하고, 프롬프트·정답·개인 경로·자격증명을 싣지 않는다.
벤치마크의 모델 입력은 선택한 공급자로 전송되지만, 개인 대화나 문서가 전송되는 것은 아니다.
평가 원문이나 정답을 학습 데이터에 자동 편입하지 않는다. 파인튜닝은 별도의 데이터·승인·보류 평가가 필요하다.

각 문항·설정마다 새 CLI/새 세션을 사용하는 **cold end-to-end** 평가다. 지속 대화의 warm 응답속도를 측정한 것으로 해석하지 않는다.
동일 문항의 두 설정은 교차 순서로 실행한다. 실행 코드가 도중에 바뀌면 두 원본 보고서에도 `provenanceValid=false`를 남겨 이후 재비교에서도 승격을 막는다.
`--help` 이외의 옵션에는 값을 명시한다. 기존 보고서는 덮어쓰지 않으며, 전송/인증 오류가 발생하면 추가 사용량 소비를 중단한다.

## 라이선스와 외부 공개

BFCL 데이터/코드는 [Apache-2.0](https://raw.githubusercontent.com/ShishirPatil/gorilla/main/LICENSE), OSWorld·WebArena·BrowserGym 코드는 Apache-2.0,
SWE-bench와 τ-bench 코드는 MIT다. 시험 대상 저장소·VM 이미지·사이트·추가 파일은 별도 조건도 확인해야 한다.
GAIA는 [데이터 카드](https://huggingface.co/datasets/gaia-benchmark/GAIA/blob/main/README.md)의 접근 및 재배포 제한을 따른다.
이번 작업은 외부 리더보드 제출을 하지 않는다. 특히 [SWE-bench 제출](https://www.swebench.com/SWE-bench/reference/cli/#submit)은 예측·실행 로그·궤적 공개가 포함되므로 별도 검토와 요청이 필요하다.
