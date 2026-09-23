# 로컬 모델 파인튜닝 준비와 검증

Mr.Robot의 **추론 설정 튜닝**과 **모델 가중치 파인튜닝**은 다릅니다. Codex·Claude 구독 모델의 가중치는 이 앱에서 변경할 수 없습니다. 이 기능은 사용자가 라이선스를 확인한 **로컬 공개 가중치 모델**에 LoRA 어댑터를 학습할 수 있도록 데이터를 준비합니다. API 공급자로 데이터나 학습 작업을 전송하지 않습니다.

기존 대화, Discord 티켓, 첨부 파일, 사용자의 PC 문서를 자동 수집하지 않습니다. 앱에 명시적으로 가져온 JSONL만 처리합니다. 모델 개선 효과는 학습 데이터와 기반 모델에 달려 있으며, 파인튜닝 자체가 더 빠른 응답이나 더 좋은 도구 사용을 보장하지 않습니다.

## 데이터 준비

로컬 PC의 관리자 화면에서 데이터셋 JSONL을 검증한 후 저장하고 내보내세요. 원격 모바일·Discord 사용자가 학습 데이터를 읽거나 GPU 학습을 시작하는 기능은 제공하지 않습니다. 모듈의 로컬 통합 계약은 `LocalTuningDatasets(home).validate/import/list/export`입니다.

한 줄에 한 대화 예제를 넣습니다. 선택적 system 메시지 다음에 user와 assistant가 번갈아 와야 하며 마지막은 assistant입니다. tool 호출, URL 입력, 파일 경로를 따라 읽는 동작은 지원하지 않습니다.

```jsonl
{"messages":[{"role":"user","content":"다음 변경의 효과를 짧게 설명해줘: 캐시 TTL을 추가했다."},{"role":"assistant","content":"오래된 결과를 무기한 재사용하지 않도록 합니다. TTL이 짧으면 최신성이 좋아지고, 길면 호출량을 줄일 수 있습니다."}],"group":"cache-example-source"}
{"messages":[{"role":"user","content":"작업이 완료됐지만 확인하지 못했을 때 어떻게 보고해?"},{"role":"assistant","content":"변경은 완료했지만 실제 동작 검증은 아직 하지 않았다고 구분해서 보고합니다."}],"group":"report-example-source"}
```

- 1회 최대 2MiB·2,000개 예제, 메시지 최대 32KiB·대화당 최대 64개 메시지, 로컬 데이터셋 최대 100개입니다.
- 명백한 키·토큰·비밀번호·개인 키 형태는 저장을 차단합니다. 개인정보 의심 패턴은 경고하고 직접 검토했다는 확인이 필요합니다. 탐지는 완전하지 않습니다. 이름, 주소, 회사 기밀, 저작권과 사용 동의도 직접 검토해야 합니다.
- Unicode·대소문자·공백을 정규화한 중복을 제거합니다. 같은 사용자 질문이 하나라도 겹치거나 `group`이 같은 예제는 한 묶음으로 분리합니다. 같은 출처를 여러 질문으로 바꾼 경우에도 동일한 `group`을 지정하세요.
- 독립 묶음 전체를 학습/검증으로 나눕니다. 기본 검증 비율은 20%, 설정 범위는 5~50%입니다. 시드와 데이터가 같으면 분할도 같습니다. 중복 예제가 서로 다른 출처 그룹을 연결하는 경우에도 하나의 묶음으로 유지합니다.
- 의미가 비슷한 패러프레이즈까지 자동 식별하지는 않습니다. 사람의 출처 그룹 지정과 별도 미사용 테스트셋이 필요합니다. 반복 튜닝에 검증셋을 계속 사용하면 검증셋에도 과적합될 수 있습니다.
- 독립 묶음이 2개 미만이면 가져오기를 거부합니다. 100개 미만은 소규모 데이터 경고를 표시합니다. 이 숫자는 품질을 보장하는 최소 학습량이 아닙니다.

파일은 `MR_ROBOT_HOME/private/tuning`(기본 `%USERPROFILE%\.mr-robot\private\tuning`)에만 저장됩니다. 내보내기는 `exports/<데이터셋 ID>/train.jsonl`, `eval.jsonl`, `manifest.json`을 만듭니다. 경로를 외부에서 지정하거나 실제 대화 저장소를 자동 읽지 않습니다. 심볼릭 링크·정션 경로를 거부하고, 체크섬으로 내보낸 파일을 재검증합니다. 검사 결과에는 원문이나 탐지한 비밀 값을 출력하지 않습니다.

저장 파일은 OS 사용자 계정 보호에 의존하는 **로컬 평문**입니다. E2EE 또는 암호화 저장을 주장하지 않습니다. 공유 PC라면 Windows 사용자 ACL·디스크 암호화를 사용하고, 데이터 폴더를 Git·공유 드라이브에 올리지 마세요. 프로젝트의 `/private/`와 `.mr-robot/`는 Git에서 제외되어 있습니다.

## 1. 학습 없이 준비 상태 확인

`scripts/local-finetune.py`는 기본적으로 dry-run입니다. 선택한 내보내기의 형식·분할 누수·자격증명 패턴·체크섬과 설치된 라이브러리/GPU 정보를 검사합니다. 다운로드, 설치, 모델 로딩, 학습, 외부 전송을 하지 않습니다.

```powershell
python scripts/local-finetune.py --dataset-dir "C:\path\to\private\tuning\exports\DATASET-ID"
```

이미 준비한 기반 모델도 검사하려면 `--model-dir "C:\Models\ReviewedModel"`을 추가하세요. Hub 모델 ID가 아니라 **로컬 디렉터리**여야 합니다. `config.json`, tokenizer와 chat template, 완전한 safetensors 가중치를 미리 준비해야 합니다. 모델 라이선스, 출처와 해시를 직접 확인하세요. pickle 가중치와 사용자 정의 remote model code는 허용하지 않습니다.

선택적 의존성은 `torch`, `transformers`, `datasets`, `peft`, `trl`, `accelerate`, `safetensors`입니다. NF4 학습에는 `bitsandbytes`도 필요합니다. 별도 가상환경에서 하드웨어에 맞는 버전을 직접 설치하세요. 앱은 이를 자동 설치하거나 기존 환경을 변경하지 않습니다. 설치된 TRL이 `SFTConfig.completion_only_loss/max_length/eval_strategy`와 `SFTTrainer.processing_class`를 지원하는지 실행 전에 확인합니다. API가 맞지 않으면 중단하며 임의로 옵션을 무시하지 않습니다.

## 2. 사용자가 명시적으로 시작하는 로컬 학습

준비 상태를 확인한 뒤 다음 플래그를 **직접** 넣어야 학습합니다. CPU 학습은 추가로 `--allow-cpu`가 필요합니다.

```powershell
python scripts/local-finetune.py --dataset-dir "C:\path\to\private\tuning\exports\DATASET-ID" --model-dir "C:\Models\ReviewedModel" --train --confirm-local-training --rank 8 --learning-rate 0.0001 --epochs 1 --max-steps 100 --max-length 1024
```

CUDA와 호환되는 bitsandbytes 환경에서 QLoRA를 선택하려면 `--quantization nf4`를 추가합니다. 기본값은 양자화 없는 LoRA입니다. VRAM 체크는 호환성/용량 참고 정보이며 메모리 적합성을 보장하지 않습니다. 데이터가 길면 메모리 부족이 생길 수 있습니다.

실행 규칙:

- 항상 `local_files_only=True`, `trust_remote_code=False`, safetensors 사용. Hub 업로드와 실험 추적 서비스 전송은 꺼집니다. 셸, 임의 코드 eval, 외부 명령 실행은 없습니다.
- 사용자/시스템 메시지 전체를 정답으로 학습하지 않고 **각 예제의 마지막 assistant 답변**에 대해서만 completion loss를 계산합니다. 이전 대화는 문맥으로 사용합니다.
- 예제가 최대 토큰 길이를 넘으면 조용히 자르지 않고 중단합니다. 데이터 정리 또는 명시적인 길이 조정이 필요합니다.
- rank는 4/8/16/32/64, 단계 수는 최대 10,000, 길이는 최대 8,192토큰입니다. `epochs`에서 계산한 단계 수와 `max-steps` 중 작은 값을 사용합니다. batch 1과 기본 gradient accumulation 8을 사용합니다.
- 기반 모델을 자동 수정하거나 앱에 새 어댑터를 자동 적용하지 않습니다. 내보내기 폴더의 `runs/<UTC 시각>` 아래에 별도 LoRA 어댑터와 라이브러리 버전·학습 전후 검증 loss 보고서를 저장합니다.
- 낮아진 validation loss만으로 에이전트 성능 향상을 결론 내리지 마세요. 별도 테스트셋에서 작업 성공률, 잘못된 도구 호출, 권한 준수, 첫 응답/완료 지연, 토큰량을 함께 비교해야 합니다.

학습된 어댑터는 호환되는 로컬 모델 서버에서 기반 모델과 함께 로딩해야 합니다. 그런 서버의 로컬 OpenAI 호환 엔드포인트를 Mr.Robot 공급자에 등록해 사용할 수 있습니다. 이 기능은 **모델 서버 자동 설치·배포까지 수행하지 않습니다**. 기존 구독 공급자 설정은 바꾸지 않습니다.

## 근거와 검증 범위

[LoRA 논문](https://arxiv.org/abs/2106.09685)은 기반 가중치를 동결하고 작은 저랭크 행렬을 학습하는 방법입니다. [QLoRA 논문](https://arxiv.org/abs/2305.14314)은 4비트 양자화와 LoRA를 결합해 학습 메모리를 줄이는 접근입니다. 논문의 특정 모델/하드웨어 성능 수치를 이 앱의 실측 성능으로 인용하지 않습니다.

구현 계약은 [TRL SFTTrainer 공식 문서](https://huggingface.co/docs/trl/sft_trainer), [TRL SFTConfig 소스](https://github.com/huggingface/trl/blob/main/trl/trainer/sft_config.py), [PEFT 양자화 공식 문서](https://huggingface.co/docs/peft/developer_guides/quantization)를 확인했습니다(2026-09-23). 별도 라이브러리의 코드를 복사하지 않고 해당 공개 API를 호출합니다.

자동 테스트는 합성 데이터로 JSONL 검증·누수 방지·민감정보 차단·경로/체크섬 보호·dry-run과 명시적 학습 승인 조건을 검증합니다. **이 변경 검증 과정에서는 실제 사용자 대화 수집, 모델 다운로드, GPU 학습, 모델 품질 향상 측정을 수행하지 않았습니다.**

```powershell
node --import tsx --test packages/agent/test/tuning-datasets.test.ts
npm run test:local-training
```

테스트 실행기는 PATH에서 실제 `python`·`python3`·`py -3` 후보를 짧게 확인하고 Python 3.10 이상만 사용합니다. Windows Store 실행 별칭은 건너뜁니다. 설치나 모델 다운로드는 하지 않습니다. 별도 가상환경이나 PATH에 없는 Python은 실행 파일의 **절대 경로만** 지정하세요. 인수나 따옴표를 경로 값 안에 추가하지 않습니다.

```powershell
$env:MR_ROBOT_PYTHON = "C:\Python312\python.exe"
npm run test:local-training
Remove-Item Env:MR_ROBOT_PYTHON
```

위 경로는 예시입니다. 실제 설치 경로로 바꾸세요. `MR_ROBOT_PYTHON`을 지정했는데 실행되지 않으면 다른 Python으로 조용히 바꾸지 않고 오류를 표시합니다.
