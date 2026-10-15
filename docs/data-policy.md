# Data policy

## 사용 범위

원본 제공자가 승인한 개인 연구 범위에서 Instagram influencer dataset을 사용합니다. 동봉된 이용 조건과 실제 승인 내용을 로컬에 보관하고 따릅니다. 공개 SNS, 데이터 다운로드 승인, 코드 공개는 서로 다른 권한입니다. 승인 범위를 넘는 상업 이용·재배포·외부 모델 전송·공개 페르소나 데모는 별도 검토 없이는 진행하지 않습니다.

[원본 데이터셋 소개](https://sites.google.com/site/sbkimcv/dataset/instagram-influencer-dataset) · [공식 저장소](https://github.com/ksb2043/instagram_influencer_dataset)

## 공개 / 비공개 경계

| 공개 가능한 산출물 | 로컬 비공개 산출물 |
|---|---|
| 일반화한 코드·설계·설정 템플릿 | 원본 사진·캡션·메타데이터·매핑·archive cache |
| 실제 인물과 무관한 합성 테스트 | 승인 이메일·배포 URL·Drive 폴더/파일 ID |
| 식별 정보를 제거한 방법론과 집계 결과 | 후보 명단·실제 인물별 JSONL·검색/추출 결과 |
| 조건을 검토한 코드 라이선스 | 다운로드 영수증·인물별 오류·평가 보고서 |
| 합성 persona·합성 대화/채팅UI fixture | 실제 인물 persona 정의·말투 근거·세션 대화·tool trace·검수 기록 |

`data/`, `reports/`, `*.private.md`, 실제 매체 파일과 `.env`는 `.gitignore`로 제외합니다. 이는 실수 방지 장치이지 공개 허가나 접근 통제가 아닙니다. Git 추가·공개 전에 staged 파일과 과거 이력을 별도로 확인합니다. 이미 추적된 파일은 ignore 규칙만으로 제거되지 않습니다.

원본 승인 내용과 후보 정보를 공개 README, 예제 설정, 테스트 fixture, 터미널 캡처나 CI 로그에 복사하지 않습니다. 서비스 실행(API·워커)에서 외부 모델·호스트로 나가는 데이터는 아래 [외부 전송](#외부-전송) 표의 경로뿐이며, 연구·평가 스크립트의 외부 호출은 같은 절에 따로 적습니다.

연구용 AI 페르소나는 실제 본인/공식 계정이 아닌 시뮬레이션임을 표시합니다. 실제 인물의 비공개 관계·감정·의도·사적 기억을 설계로 채워 사실처럼 말하지 않습니다. 사용자와의 채팅도 실제 인물의 현실 이력이나 관계로 기록하지 않습니다. 승인된 로컬 연구용 채팅과 공개/상업용 실존인물 챗봇 배포는 구분합니다.

포스트/이미지는 AI 가상 초안으로 표시하고 실제Instagram에 업로드하지 않습니다. 생성물을 실제 게시물/사건/평가정답으로 재유입하지 않습니다. External image는 외부 API이므로 모델 선택과 별개로 개인 자격·비용·원본/사진 reference 전송 조건을 확인합니다. 다른 프로젝트 cookie/API key는 사용하지 않습니다. [창작물 계약](creative-artifacts.md).

## 외부 전송

연구 책임자(사용자)가 2026-10-09에 아래 외부 전송 경로를 허용했습니다. Compose 스필오버는 2026-10-15에 추가된 명시적 운영 설정을 따릅니다. 모두 기본값은 꺼짐이거나 운영자가 직접 켜야 하는 구성이며, 켜면 아래 데이터가 이 컴퓨터 밖으로 나갑니다. 유료 호출은 공통 예산 원장(Postgres `ptr_provider_requests`·`ptr_provider_budget`)을 거칩니다. 비용 상한과 호출 수 상한은 환경변수가 아니라 Postgres `ptr_provider_budget` 행(`id='global'`의 `cap_microusd`·`call_cap`)입니다.

| 경로 | 켜는 조건 | 보내는 데이터 | 받는 곳 |
|---|---|---|---|
| Jev 의도 분류 | `PTR_INTENT_CLASSIFIER=jev` + `GOAL1_LIVE_ENABLED=true` + `GOAL1_ALLOW_EXTERNAL_DATA=true` + `OPENROUTER_API_KEY` | 규칙으로 의도가 정해지지 않은 턴에서만(검색 없는 대조 세션 제외): 이번 사용자 발화 앞 500자, 같은 세션의 직전 사용자 발화 최대 2개(각 300자, 자격 정보 패턴·민감 발화 제외), 고정 질문문 | OpenRouter Decisions API, 모델 `typesafe/jev-1.13`(TypeSafe) |
| Jev 입력 안전 검사 | `PTR_SAFETY_FILTER=jev` + 위 live 조건 | 모든 턴(규칙이 이미 거절한 턴은 자해 질문만): 이번 사용자 발화 전체(첫 500자 창 + 4100자 창들), 직전 사용자 발화 최대 2개, 고정 질문문. 창작 초안 요청이면 초안 지시문(최대 2000자) | 같음 |
| Compose / Kubernetes paid spillover (기본 off) | `PTR_LLM_PROVIDER=local` + `PTR_LLM_SPILLOVER=openrouter` + `PTR_LLM_LIVE_ENABLED=1` + `PTR_LLM_ALLOW_EXTERNAL_DATA=1` + 원장 DB + worker-only OpenRouter key. Compose는 `PTR_LLM_LOCAL_SLOTS` 설정과 Redis 공유 슬롯 2초 대기 초과, Kubernetes는 EPP `rejected-saturated` 또는 `rejected-ttl-expired` 첫 시도 drop reason일 때만. DeepInfra ZDR 확인 필수 | 그 턴의 프롬프트 전체: 정책 문구, 페르소나 카드(실존 인물 페르소나의 배경 포함), 근거 게시물 최대 3건의 원본 캡션(이미지 조건이면 AI 이미지 설명 포함), 최근 대화, 사용자 발화, 이전 대화 요약과 동의한 사용자 기억(`USER_MEMORY`), 동의한 이전 세션에서 사용자가 직접 한 안전한 발화(첫 응답에서만). 요약 생성은 spillover 중 미루지만 채팅 프롬프트에 이미 포함된 요약·기억은 외부 전송 대상입니다. 엔진 5xx, bare 503, timeout, reset은 spillover grant가 아닙니다 | OpenRouter → DeepInfra 고정, 모델은 `PTR_LLM_OPENROUTER_MODEL` |
| 자체 엔진(RunPod) | `PTR_LLM_PROVIDER=local` 또는 Kubernetes EPP/InferencePool local route | 모든 채팅 턴의 프롬프트 전체(실존 인물 데이터 포함) | RunPod에서 빌린 GPU 호스트(제3자 하드웨어)의 vLLM/SGLang. Compose는 127.0.0.1 SSH 터널로만 접속하고, Kubernetes는 EPP/InferencePool을 통해 접속합니다 |

- OpenRouter 요청(Jev·spillover)은 `data_collection: deny`, `zdr: true`, `allow_fallbacks: false`와 가격 상한을 붙여 보냅니다. 이것은 요청 조건이며, OpenRouter와 그 뒤 제공자가 실제로 지키는지는 이 코드가 검증하지 못합니다.
- Paid spillover는 DeepInfra ZDR endpoint 확인에 실패하면 꺼집니다. 60초마다 키·가격·ZDR을 다시 확인하며 ZDR 조건을 제거해서 보내지 않습니다. 프롬프트/완성 가격 상한은 백만 token당 US$0.1/US$0.5, 누적 원장 상한은 US$1입니다. 기본 `PTR_LLM_OPENROUTER_KEY_LIMIT_CHECK=required`는 전용 worker key의 lifetime credit limit도 US$1 이하로 요구합니다. 명시적 `skip`은 키 인증은 유지하지만 이 per-key 제한을 생략하므로 원장 상한과 계정 단위 제한에 의존하며 지출 위험이 커집니다. 검증은 가짜 OpenRouter만 사용하며 실제 유료 제출은 GPU가 실제 포화일 때만 허용합니다. 제출 전 거절은 로컬 대기로 돌아가고, 제출 후 실패/unknown은 재제출하지 않습니다.
- Paid spillover는 턴 id를 원장 멱등 키로 씁니다. 같은 턴의 재시도는 끝난 응답을 재사용하거나, 결과가 미확정이면 다시 보내지 않습니다(이중 과금 없음). 예산은 durable ledger로 제한하고, 기본 모드에서는 worker-only provider key credit limit도 적용합니다.
- Jev 호출이 실패하거나 시간을 넘기면 규칙만으로 처리합니다(fail-open). 페르소나 카드·캡션·모델 응답은 Jev로 보내지 않습니다.
- RunPod 호스트는 이 저장소 밖의 제3자 장비입니다. 프롬프트는 그 호스트의 엔진 프로세스가 처리하며, 호스트의 디스크·로그 보존과 접근 통제는 이 코드가 관리하지 않습니다. 접속 정보와 호스트 정보는 저장소에 두지 않습니다.
- 이 표 밖의 직접 OpenRouter 연구 실행(채팅과 질의 임베딩)도 같은 live 조건과 원장으로 OpenRouter에 보냅니다. External image는 위 창작물 계약을 따릅니다.
- 연구·평가 스크립트(운영자가 live 조건을 켜고 직접 실행할 때만): `scripts/live-research.ts`는 라이선스 원본 캡션을, `scripts/import-image-annotations.ts`는 AI 이미지 설명 텍스트를 임베딩용으로 OpenRouter(`openai/text-embedding-3-small`)에 보냅니다. `scripts/evaluate.ts`, `scripts/evaluate-memory-context.ts`, `scripts/provider-bench.ts`, `scripts/bench-jev-gemma.ts`, `scripts/evaluate-jev-*.ts`, `scripts/s8-gates.ts`는 평가용 대화 프롬프트나 사용자 발화를 위 표와 같은 방식(OpenRouter 채팅·Jev, 또는 RunPod 엔진)으로 보냅니다.
- 자체 엔진 local 경로에는 실제 질의 임베딩이 없습니다. semantic 세션은 만들 수 없고(`SEMANTIC_UNAVAILABLE`), 임베딩을 위한 새 외부 전송은 연결하지 않았습니다.

## 대상과 최소화

- 성인 개인 크리에이터로 제한합니다. 미성년자·어린이 중심 계정은 후보에서 제외하며 자동 연령 판정은 구현하지 않습니다.
- 국내 코호트는 공개 한국어 콘텐츠·한국 활동 근거로 분류하며 사용자명·외모만으로 국적을 단정하지 않습니다. 실제 후보와 분류 근거는 비공개 보고서에만 보관합니다.
- 정규화는 게시물 소유자 ID, 캡션, 게시 시각, 출처, 매체 경로 등 제한된 필드만 남깁니다. 댓글·사용자 태그 구조를 제외하고 비공개 owner로 표시된 레코드는 거부합니다.
- 원본에는 댓글·제3자·미성년자가 포함될 수 있습니다. 원본 보존과 분석 대상 채택은 구분합니다. 캡션·사진의 자동 민감정보 제거·익명화는 **미구현**이므로 검수가 필요합니다.
- 사건 추출에서 제3자의 이름·관계·얼굴을 식별하지 않고 필요하면 “동행인” 등 유형만 기록합니다. 연락처·주거지·실시간 위치·민감정보·루머·사생활 추론은 제외합니다.
- 공개 여행·작업·행사 등 필요한 활동만 분석하며, 게시물을 그 사람의 모든 활동에 대한 완전한 기록으로 취급하지 않습니다.

## 검증과 보존

게시 시각을 사건일로 복사하지 않습니다. 과거 사진·회고·광고·미래 계획은 실제 활동과 구분하고 근거가 부족하면 사건일을 미확정으로 둡니다. 계정 사용자명 변경과 snapshot 시점 차이는 검수 대상입니다.

다운로드 무결성과 분석 정확성은 별개입니다. 크기·CRC·소유자·매핑·계정별 누락을 확인한 뒤에도 이미지 내용과 날짜는 별도 검수해야 합니다. partial 다운로드나 이미지 누락을 완료로 보고하지 않습니다.

필요한 부분집합만 보존하고 연구가 끝나거나 승인이 변경되면 보존 필요성을 재검토합니다. 로컬 파일 암호화·접근 제어·백업·삭제 기한은 운영자가 별도로 정해야 하며 현재 scaffold가 자동 제공하지 않습니다.

### 대화 요약과 사용자 기억 (C4)

대화 원문·최근 메시지, 세션 요약, 사용자 기억, 삭제한 기억의 제외 표시, 실행 권한의 context/result, LLM receipt·LangGraph 체크포인트는 모두 비공개 대화 데이터입니다. 요약과 사용자 기억은 사용자가 말한 내용과 대화 흐름이며, 실존 인물의 활동 근거가 아닙니다. 요약은 최근 창보다 오래된 대화를 로컬 모델로 압축하며 외부 spillover 중에는 생성을 미룹니다. 약 20개 메시지마다 요약을 시도하는 턴은 로컬 요약 호출 때문에 완료가 최대 약 4초 늦어질 수 있습니다.

사용자 기억은 기본 꺼짐이고 명시적으로 동의한 뒤에만 추출·저장합니다. 그 턴에서 직접 쓴 문장에서 나온 이름·선호·비선호·최근 일·기타만 받으며, 항목당 120자, owner·페르소나당 **활성 기억** 30개로 제한합니다. 건강·정치·종교·성적 지향·정확한 위치·연락처·금융·미성년 여부는 거부합니다. owner 범위의 화면/API에서 기억을 보고 하나씩 또는 전부 삭제할 수 있습니다. 기억을 지우면 해당 owner·페르소나의 요약도 비우고, 남은 기록으로 다시 만듭니다. 삭제한 기억의 원문은 재추출 방지와 요약 제외를 위해 보존하며, 기본 90일의 보존 기간이 지나면 활성화된 일일 정리에서 삭제합니다. 그 뒤에는 제외 표시가 사라져 같은 내용을 사용자가 다시 말하면 다시 추출될 수 있습니다. 부분 문자열 제외와 요약 원문 가리기에 원문이 필요하므로 해시만으로는 현재 계약을 지킬 수 없습니다. 최근 대화 원문에는 삭제한 기억이 남으므로 완전히 지우려면 대화를 삭제하세요.

대화를 삭제하면 화면과 API에서는 즉시 사라지고, 남은 사본은 다음 일일 정리에서 지워진다(정리 타이머가 켜져 있을 때). 삭제 요청은 메시지·요약·해당 세션에서 나온 기억을 지우고, 세션·turn에 삭제 표시를 하며 turn 입력과 reply, 실행 권한 context/result를 비웁니다. 진행 중인 턴이 있으면 삭제를 거부합니다. 해시와 execution ID는 다음 정리를 위해 남깁니다. 다음 일일 정리는 일반 보존 기간을 기다리지 않고 LLM receipt·turn 체크포인트와 저장된 요청 키로 연결된 가상 초안 체크포인트를 정리한 뒤 turn·세션과 초안을 지웁니다. 같은 초안 요청 키가 활성 대화에서도 쓰이면 활성 사본을 보호하려고 해당 삭제 표시 세션의 정리를 미룹니다. 요청 키가 기록되지 않은 과거 초안의 체크포인트는 자동 연결할 수 없습니다. Compose는 `ptr-maintenance-daily.timer`, Kubernetes는 `ptr-maintenance-daily-split-retention`이 활성이고 마지막 실행이 성공해야 합니다([운영 점검](operational-deployment.md)).

Langfuse는 운영 기본값 `LANGFUSE_CAPTURE_CONTENT=false`로 내용 수집이 꺼져 있습니다. 내용을 수집하도록 켰다면 대화 삭제로 Langfuse 사본까지 지워지지 않습니다. 별도 Langfuse 보존·삭제 절차가 필요합니다.

### 사람 검수 시트

- `scripts/review-sample.ts`가 만드는 검수 시트(`reports/review/*.private.md`)에는 실존 인물 페르소나와 실제 사용자의 발화·응답 전문이 들어갑니다. 디렉터리 0700, 파일 0600이며 git에서 제외됩니다. 절차와 기준은 [사람 검수 표본](review-sampling.md)에 있습니다.
- 시트 옆의 추적 파일(`reports/review/*.trace.private.json`, 0600)에는 시트별 솔트와 마스킹 id → 턴 id 대응이 있습니다. 사고 대응(해당 턴 찾기·삭제)에만 씁니다.
- 보존 기한은 시트와 추적 파일 모두 90일입니다. 더 오래된 파일이 있으면 스크립트가 실행을 거부하고, `--prune`으로 둘 다 지운 뒤에만 진행합니다. 위 문단의 예외로, 이 기한은 도구가 강제합니다.
- **에이전트는 `reports/review/**`와 S8 결과 파일의 행 내용을 읽지 않습니다.** 확인은 파일 존재·권한·행 수만 합니다. 스크립트의 터미널 출력은 건수뿐이고, 시트는 외부로 보내지 않습니다.

## 코드 라이선스

현재 별도 코드 `LICENSE`는 지정하지 않았습니다. 향후 코드 라이선스를 명시하더라도 적용 대상은 자체 작성 코드이며, 승인 데이터·사진·캡션·원본 제공자 자료에 대한 재배포 권리를 부여하지 않습니다.

## 출처 (외부 전송 절, 코드 기준)

- Jev 요청 구성과 보내는 상태: `packages/providers/src/jev.ts` (`decisionState`, `DEFAULT_JEV_MODEL`), 직전 발화 선택: `packages/core/src/chat-service.ts` (`recentUserTurns`), 안전 검사 창: `packages/core/src/input-safety.ts` (`SAFETY_WINDOW`), 의도 분류 조건: `packages/core/src/intent-routing.ts` (`needsIntentClassifier`), 켜는 설정: `apps/api/src/runtime.ts`
- OpenRouter 요청 조건과 live 조건: `packages/providers/src/openrouter.ts` (`provider()`, `decide()`, `liveOptionsFromEnvironment`), 원장: `packages/providers/src/budget.ts`
- Paid spillover 조건과 모델: `apps/llm-service/src/ptr_llm/providers/local.py`, `apps/llm-service/src/ptr_llm/runtime.py`, Kubernetes EPP drop reasons in `docs/kubernetes.md`
- 프롬프트 구성(근거 3건): `packages/core/src/prompts.ts` (`buildExperimentContext`, `EVIDENCE_POST_LIMIT`)
- 자체 엔진 연결: `apps/llm-service/src/ptr_llm/providers/local.py`, Kubernetes EPP/InferencePool in `docs/kubernetes.md`, GPU 호스트 스크립트: `infra/gpu/README.md`
- 스크립트의 외부 호출: `scripts/live-research.ts` (`client.embed`), `scripts/import-image-annotations.ts` (`client.embed`), 그 밖에 `OpenRouterClient`를 만드는 `scripts/*.ts`
- semantic 거절: `apps/api/src/runtime.ts` (`semanticSearch`), `packages/core/src/chat-service.ts` (`createSession`)
