# BFCL V4 공개 부분집합 · Mr.Robot 자체 채점

공식 BFCL 리더보드 점수가 아니다. 도구 선택·인자를 기록한 제한된 실험이며 GUI·코딩·전체 에이전트 성능으로 환산하지 않는다.

## 비교 요약

| 지표 | 기준 | 후보 |
| --- | ---: | ---: |
| 모델 / 추론 | `gpt-5.6-terra` / `medium` | `gpt-5.6-terra` / `high` |
| 분할 | dev | dev |
| 정답 / 예정 문항 | 35/40 | 33/40 |
| 정확도 | 87.5% | 82.5% |
| 정확도 Wilson 95% 구간 | 73.9%–94.5% | 68.1%–91.3% |
| 시도 / 완료 / 누락 | 40 / 40 / 0 | 40 / 40 / 0 |
| cold 완료 p50 / p95 (ms) | 7,141.51 / 10,156.68 | 6,991.25 / 11,846.25 |
| 첫 텍스트 p50 / p95 (ms) | 5,657.96 / 8,373.1 | 4,736.4 / 7,168.39 |
| 첫 텍스트 관측 수 | 40 | 40 |
| 사용량 완전 보고 수 | 40/40 | 40/40 |
| 정답 1개당 토큰 | 6,307.37 | 6,903.09 |
| 호출 수 | 46 | 46 |

전체 정확도는 누락을 실패로 계산한다. 토큰은 공급자가 보고한 값이며 미보고는 0으로 계산하지 않는다.
cold 지연은 BFCL 실행기의 매 문항·설정별 새 세션 기준이다. warm 지속 대화 속도를 나타내지 않는다.
지연 분포는 관측 시도 기준이며 실패·시간 제한도 포함한다. Wilson 구간은 단일 설정 정확도의 불확실성이지 두 설정의 우월성 검정이 아니다.

## 범주별 결과

| 범주 | 기준 정답/관측 | 후보 정답/관측 | 기준 정확도 | 후보 정확도 |
| --- | ---: | ---: | ---: | ---: |
| simple_python | 9/10 | 7/10 | 90.0% | 70.0% |
| multiple | 8/10 | 8/10 | 80.0% | 80.0% |
| parallel | 9/10 | 9/10 | 90.0% | 90.0% |
| irrelevance | 9/10 | 9/10 | 90.0% | 90.0% |

범주별 분모는 관측 문항 수다. 중단된 실행의 누락 범주는 이 표에 배정되지 않으므로 전체 분모와 구분한다.

## 고정 검토 기준

검토 기준을 충족하지 않았다. 이 결과로 기본 설정을 승격하지 않는다.

- 기준: `bfcl-custom-holdout-review-v1`
- 자동 활성화: 없음
- 외부 리더보드 제출: 없음
- Development results are diagnostic only; use an untouched holdout.
- Observed overall accuracy declined.
- Observed simple_python accuracy declined.
- No fixed-threshold practical improvement was observed.

## 실패 유형

| 설정 | 실패 코드 | 수 |
| --- | --- | ---: |
| 기준 | `arguments_mismatch` | 3 |
| 기준 | `irrelevant_call` | 1 |
| 기준 | `missing_call` | 1 |
| 후보 | `arguments_mismatch` | 5 |
| 후보 | `irrelevant_call` | 1 |
| 후보 | `missing_call` | 1 |

## 재현 출처

| 항목 | 기준 | 후보 |
| --- | --- | --- |
| revision | `f7cf7359b7ac615a0b294831c5ba2bc95ee4a000` | `f7cf7359b7ac615a0b294831c5ba2bc95ee4a000` |
| partitionHash | `e2c64d90fe791ec64126f51a742b946429e08694a42daf16dfc83049727e49ac` | `e2c64d90fe791ec64126f51a742b946429e08694a42daf16dfc83049727e49ac` |
| seed | `mrrobot-bfcl-v1` | `mrrobot-bfcl-v1` |
| experimentId | `eee64932-3631-41df-823f-e9b0ee829f5e` | `eee64932-3631-41df-823f-e9b0ee829f5e` |
| cliVersion | `0.153.4` | `0.153.4` |
| provenanceValid | `true` | `true` |

### 기준 데이터·소스 해시

| 종류 | 식별자 | SHA-256 |
| --- | --- | --- |
| datasetHashes | `irrelevance.questions.jsonl` | `2b6ed4c2e992cdcf5f1678a701851f944bef7550ee026ed1ddb89efed5be01a6` |
| datasetHashes | `LICENSE` | `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4` |
| datasetHashes | `multiple.answers.jsonl` | `244e00ce9395df948bcafc7bee64e8f9c87ef70887587d83cae45b13699f3047` |
| datasetHashes | `multiple.questions.jsonl` | `aef168155ebd74b7ac2401198b201343bc7d16d7a3d7e0d4e6d8ee82c6969b2a` |
| datasetHashes | `parallel.answers.jsonl` | `8a6aa19c1adddc6a5a2f7e40f9dbf30cc7e95815e7b830c90589ab318229e0f0` |
| datasetHashes | `parallel.questions.jsonl` | `19f51a82eff42e5d62541aa500115a056eb78f437c2ba1f10415fd7c8e5dda84` |
| datasetHashes | `simple_python.answers.jsonl` | `90cd5bc653690ee8e459b5b3f3fc9458606f7f3fcbf795bb51b7dc581f8c86dc` |
| datasetHashes | `simple_python.questions.jsonl` | `82dd63ba502eb2520c6b5d1d9a5c4b590e03ff261565175561f6228a367d1991` |
| sourceHashes | `package-lock.json` | `7b84d7bb6febe6cee2861bf4ce20283bbce742209f75eaa063c1d22be3181c46` |
| sourceHashes | `packages/agent/src/ai/cli-isolated.ts` | `02480f46971d37c068fdf7561bf16e9e87f4a24106269105ad36d47f26499e85` |
| sourceHashes | `packages/agent/src/ai/cli-models.ts` | `2ac2a70206f396a8d366c003066049ad32ad90bbcf4b913a9bda301be85489b5` |
| sourceHashes | `packages/agent/src/ai/cli-process-retirement.ts` | `50f12c426e2d4f1cb15e006475672262dadb6ebf973902d41a42238d7115ef35` |
| sourceHashes | `packages/agent/src/ai/cli-session-events.ts` | `290a628d28644f16a2a77b57141c1ffb41a106f765cd1f3b43b251addf217095` |
| sourceHashes | `packages/agent/src/ai/cli-text-pool.ts` | `db7708d03b5f142bd1e003e4ea52d036056075ebff01014b73c68ef960d1783f` |
| sourceHashes | `packages/agent/src/ai/cli.ts` | `2c64f6e9777ef076eeb6c10e1cb9cf376a7e58109aad816d0de8d169b00727f9` |
| sourceHashes | `packages/agent/src/ai/native-run-scheduler.ts` | `8659a43e387525b4de476e7880d6b73fd7cc02a42cac1dcc3ec4cbdf23907263` |
| sourceHashes | `packages/agent/src/ai/provider.ts` | `fa74de21f36127043387d0ae6181d2c6b90c114f02780ec9f54a3ed8a8ea92c2` |
| sourceHashes | `packages/agent/src/computer/shell.ts` | `9b107f7dbe5498311d9d04fc97ce03c0b8f66514ec88e8f8df7a1aba15a3a1d3` |
| sourceHashes | `packages/agent/src/evaluation/external-scorecard.ts` | `3b0cee198fb704416f62558bb0e53a3ebf7042a5f9651a382dc85bab12387c5f` |
| sourceHashes | `packages/agent/src/evaluation/external-tool-benchmark.ts` | `1d8adb007ee93810ed42f8cc98afbf8c6204275b94b3c5163449c6a5ce284772` |
| sourceHashes | `scripts/benchmark-bfcl-data.ts` | `2d6eb1f1fdd0256f2adfc91575db937d17f25426c51edb9be4969e20c67e4d4f` |
| sourceHashes | `scripts/benchmark-bfcl.ts` | `11f6764620ffa8c995a5ac77cae25daf3a7796a19423c37b8f499862fc9f7a82` |
| sourceHashes | `scripts/performance-common.ts` | `a5487d9216507ae5ebf2ac79e7ab6e3962834d8a9b933bbe60ea07f8d4388fb9` |

### 후보 데이터·소스 해시

| 종류 | 식별자 | SHA-256 |
| --- | --- | --- |
| datasetHashes | `irrelevance.questions.jsonl` | `2b6ed4c2e992cdcf5f1678a701851f944bef7550ee026ed1ddb89efed5be01a6` |
| datasetHashes | `LICENSE` | `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4` |
| datasetHashes | `multiple.answers.jsonl` | `244e00ce9395df948bcafc7bee64e8f9c87ef70887587d83cae45b13699f3047` |
| datasetHashes | `multiple.questions.jsonl` | `aef168155ebd74b7ac2401198b201343bc7d16d7a3d7e0d4e6d8ee82c6969b2a` |
| datasetHashes | `parallel.answers.jsonl` | `8a6aa19c1adddc6a5a2f7e40f9dbf30cc7e95815e7b830c90589ab318229e0f0` |
| datasetHashes | `parallel.questions.jsonl` | `19f51a82eff42e5d62541aa500115a056eb78f437c2ba1f10415fd7c8e5dda84` |
| datasetHashes | `simple_python.answers.jsonl` | `90cd5bc653690ee8e459b5b3f3fc9458606f7f3fcbf795bb51b7dc581f8c86dc` |
| datasetHashes | `simple_python.questions.jsonl` | `82dd63ba502eb2520c6b5d1d9a5c4b590e03ff261565175561f6228a367d1991` |
| sourceHashes | `package-lock.json` | `7b84d7bb6febe6cee2861bf4ce20283bbce742209f75eaa063c1d22be3181c46` |
| sourceHashes | `packages/agent/src/ai/cli-isolated.ts` | `02480f46971d37c068fdf7561bf16e9e87f4a24106269105ad36d47f26499e85` |
| sourceHashes | `packages/agent/src/ai/cli-models.ts` | `2ac2a70206f396a8d366c003066049ad32ad90bbcf4b913a9bda301be85489b5` |
| sourceHashes | `packages/agent/src/ai/cli-process-retirement.ts` | `50f12c426e2d4f1cb15e006475672262dadb6ebf973902d41a42238d7115ef35` |
| sourceHashes | `packages/agent/src/ai/cli-session-events.ts` | `290a628d28644f16a2a77b57141c1ffb41a106f765cd1f3b43b251addf217095` |
| sourceHashes | `packages/agent/src/ai/cli-text-pool.ts` | `db7708d03b5f142bd1e003e4ea52d036056075ebff01014b73c68ef960d1783f` |
| sourceHashes | `packages/agent/src/ai/cli.ts` | `2c64f6e9777ef076eeb6c10e1cb9cf376a7e58109aad816d0de8d169b00727f9` |
| sourceHashes | `packages/agent/src/ai/native-run-scheduler.ts` | `8659a43e387525b4de476e7880d6b73fd7cc02a42cac1dcc3ec4cbdf23907263` |
| sourceHashes | `packages/agent/src/ai/provider.ts` | `fa74de21f36127043387d0ae6181d2c6b90c114f02780ec9f54a3ed8a8ea92c2` |
| sourceHashes | `packages/agent/src/computer/shell.ts` | `9b107f7dbe5498311d9d04fc97ce03c0b8f66514ec88e8f8df7a1aba15a3a1d3` |
| sourceHashes | `packages/agent/src/evaluation/external-scorecard.ts` | `3b0cee198fb704416f62558bb0e53a3ebf7042a5f9651a382dc85bab12387c5f` |
| sourceHashes | `packages/agent/src/evaluation/external-tool-benchmark.ts` | `1d8adb007ee93810ed42f8cc98afbf8c6204275b94b3c5163449c6a5ce284772` |
| sourceHashes | `scripts/benchmark-bfcl-data.ts` | `2d6eb1f1fdd0256f2adfc91575db937d17f25426c51edb9be4969e20c67e4d4f` |
| sourceHashes | `scripts/benchmark-bfcl.ts` | `11f6764620ffa8c995a5ac77cae25daf3a7796a19423c37b8f499862fc9f7a82` |
| sourceHashes | `scripts/performance-common.ts` | `a5487d9216507ae5ebf2ac79e7ab6e3962834d8a9b933bbe60ea07f8d4388fb9` |

문제·정답·모델 원문·호출 인자·자격증명을 이 문서에 내보내지 않는다.
