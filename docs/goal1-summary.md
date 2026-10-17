# 목표1: 캐릭터 채팅·RAG 평가/관측 요약

이 문서는 **현재 구현 계약과 보존된 측정 결과**의 공개 요약이다. 비공개 설계 노트는 이 저장소에 포함되지 않는다. 원자료, 실제 대상 이름/계정, 실채팅, 평가 reference와 private 보고서는 공개하지 않는다. 아래 예시 대화는 모두 합성이다.

## 1. 구현 범위

- NestJS API + Next.js 채팅 + 전용 DB-only 로컬 PostgreSQL/pgvector. owner/person/persona revision/실행 profile/RAG 조건을 세션에 고정하고 재접속·history·취소·idempotency를 처리한다. 다른 프로젝트의 DB나 운영 앱을 사용하지 않는다.
- 새 세션은 [agent-loop](character-agent.md) 구조: persona + 완료된 실제 대화 + 최소 topic/tone 상태 + 원근거 → 구조화된 모델 출력 → 필요 시 제한된 읽기 전용 검색 → 자연어 캐릭터 메시지. 기본 도구 최대2회/모델 최대3회, 도구 없는 답변은1회다. 상세 사고과정은 요구/표시하지 않으며 짧은 결정 요약/상태/도구 trace는 비공개다.
- 검색은 최근 사용자 발화 최대5턴/500문자 규칙 기반 맥락과 직전 답변이 인용한 원게시물의 고정 revision을 사용한다. 별도 rewrite/planner LLM 호출은 없다. 영구 사용자 기억이나 완전한 대명사 해석은 아니다.
- 이미지 설명 생성·[별도 색인](image-rag.md)·채팅 연결까지 실행했다. `gpt-6-luna`/`medium`의 시각 관찰·중요한 강조·의도 해석과 본문 맥락을 구분한다. 본문에는 해시태그를 포함했지만 이것이 얼굴 신원 확인이나 시각 사실의 증거가 되지는 않는다. 의도 문장은 완결형이어도 AI 해석이며 `humanReviewed=false`다.
- 인물 범위/허용된 출처/annotation revision/인용 결합을 검증한다. **정확한 인용과 자연어 답변 전체의 의미적 지원은 별개**다. 선택적 validator hook은 기본 비활성이며 아래 실험도 disabled였다. legacy 인용 renderer 결과를 현재 자유 발화 경로의 성능으로 읽지 않는다.
- 합성 fixture 기반 계약 테스트와 private 실행 보고서·provider ledger/cache·비용·실행 시간·독립 SQL 감사를 갖췄다. 완전한 범용 에이전트 엔진, streaming/native tool calls, 분산 queue, 자체 모델 서빙까지 구현했다고 주장하지 않는다.

## 2. 비교하는3조건

| 조건 | 검색/모델 제공 자료 | 주의점 |
|---|---|---|
| `off` — RAG 없음 | 동일 답변 모델, 검색·embedding·원자료 lookup0 | 일반 대화/가상 창작은 가능하지만 과거 사실 근거는 제공하지 않음 |
| `caption` — 본문만 | 해당 인물의 원게시물 본문과 원문 인용 | 사진 정보/annotation을 섞지 않음 |
| `caption_image` — 본문+이미지 설명 | 본문 + 관찰/강조/의도 해석의 별도 text annotation 및 augmented vector | 원사진을 채팅 모델이 직접 보는 방식 아님; AI 설명의 오류도 가능 |

현재 실제 비교의 RAG 검색은 semantic top5를 기본으로 사용한다. `lexical | semantic`은 검색 알고리즘이고 위3조건과 다른 축이다. 본문과 이미지 설명은 별도 출처 카드로 표시한다. 검색 후보의 유사도나 유효한 출처 ID가 사용자가 뜻한 게시물임을 보장하지 않는다.

## 3. 보존된 평가 revision과 결과

모두 `google/gemini-3-flash-preview`, `agent_loop` 실행 구조의 **AI-assisted silver 개발 회귀/human review pending**이다. 사전 동결 reference/rubric와 실제 제공 근거를 대조했지만 사람이 검수한 정답률, blinded holdout, 실인물 성격 fidelity는 아니다. 원본 사진을 살펴 만든 reference와 모델에 제공한 AI 설명도 구분했다.

| 보존된 run/평가 | prompt / code | 범위·상태 |
|---|---|---|
| `paired-2026-10-04T09-26-26-406Z`의 agent-loop 답변, 오프라인 재채점 | `character-agent-context-v1`; 채점 하네스 `053b548` | 기존36답변 재채점; 신규 모델 생성 아님. 같은 run의 legacy36답변은 아래 점수에서 제외 |
| `run-2026-10-04T13-08-52-673Z` — 한국어 baseline | `character-agent-context-v1`; runner `0557f89`/안전 재개 `c06e191` | 72planned/72completed, 그중 인용 서비스 안내3 → 캐릭터 답변69 |
| `run-2026-10-04T15-16-25-422Z` — 1인칭 회상 | `character-agent-context-v2-recollection`; code `86dd195` | 72planned/71observed/68completed/3failed/1skip; 완료 중 서비스 안내5 → 캐릭터 답변63 |

Runtime revision은 `agent-loop-json-action-v1`이다. 한국어 baseline과 회상 run은 같은 study/질문/자료/언어 variant를 사용했지만 assistant history·순서·cache는 달라졌으므로 순수 prompt 인과 효과를 추정하지 않는다. 과거 workingtree provider/runtime 변경도 실제 실행 fingerprint에 포함됐으므로 위 HEAD만 checkout해 같은 live 설정/자료가 재현된다고 주장하지 않는다.

### 당시 동결된 strict 사실 진단 — 조건별 동일7질문

| 평가 | 지표 | RAG 없음 | 본문 | 본문+이미지 설명 |
|---|---|---:|---:|---:|
| agent-loop 보존 답변 오프라인 재채점 | 핵심 충족 | 1/7 | 5/7 | 6/7 |
| 동일 평가 | 핵심 충족 + 중요한 미지원 추가 없음 | 1/7 | 2/7 | 3/7 |
| 한국어 baseline | 핵심 충족 | 1/7 | 4/7 | 5/7 |
| 동일 평가 | 핵심 충족 + 중요한 미지원 추가 없음 | 1/7 | 2/7 | 2/7 |
| 1인칭 회상 run | 핵심 충족 | 2/7 | 3/7 | 5/7 |
| 동일 평가 | 핵심 충족 + 중요한 미지원 추가 없음 | 1/7 | 2/7 | 2/7 |

분모에는 기술 실패·서비스 안내·미실행 슬롯도 유지했다. 확인할 수 없는 질문에 적절히 확인불가라고 답하는 것도 reference에 따라 핵심 충족에 포함한다. 사실 외 해석2질문/가상 창작3질문은 별도 rubric이며 사실7분모에 합치지 않았다. 주요 사물만 인정하는 등 기준 민감도는 원래 private review에 보존하고 primary 점수를 사후 변경하지 않았다.

**이 표는 캐릭터 대화 전체의 성공 점수가 아니다.** 현재 제품 방향은 가벼운 분위기·반응·유머·장면 연출을 허용한다. 당시 엄격한 기준이 미지원으로 분류한 표현을 전부 현재 제품 실패로 해석하지 않는다. 확정 핵심 사건/주체의 모순, 정정 무시, 허위 실제 인용은 여전히 구분한다. 기준 변경으로 기존 답변이 개선됐다고 하거나 위 점수를 새 기준으로 전량 재채점했다고 주장하지 않는다.

### 말투와 대화 연결

- 한국어 baseline 일상36답변은 공통7축 스타일 및 집/시간/거의 무지출 제약을 충족했다. 그러나 마지막 후속12답변의 방향 유지는6충족/1일부/5실패였다.
- 회상 run 일상36관측 중34개가 정상 캐릭터 답변이고 공통 스타일 제약을 유지했다. 전후 공동 완료 마지막10턴의 방향 유지가 이전4충족/1일부/5실패 → 이후4충족/6실패여서 통합 개선을 입증하지 못했다.
- 회상 화자 후보 중 전후 정상 답변6개는 voice-only 이전/이후 모두5충족/1실패였다. 사례 범위가 작고4명 전체 고유성의 측정이 아니다.
- 일상 스타일 질문에서는 실제 검색/제공 근거가0이었다. 세조건 label만으로 RAG 자료 주입 중 말투 유지 효과를 주장하지 않는다.
- 측정 당시 페르소나는 공통 template 의존도가 높았다. 인물별 개성 fidelity는 미측정이다. 마감 작업의 차별화 정의는 아래 측정에 소급 적용되지 않으며 실제 답변의 새 효과는 미평가다.

## 4. 합성 대화 예시 — 실제 실행 결과 아님

다음은 입력/기대 경험을 설명하기 위해 만든 예시이며 실제 인물의 경험·말투·출처나 성공 증거가 아니다. 합성 자료 설정: “캐릭터가 찻집 창가에서 그림을 그렸고 사진에는 스케치북이 보인다.”

| 조건 | 사용자: “창가에서 쉬던 날 뭐 했어?”의 합성 예시 |
|---|---|
| RAG 없음 | “어느 날 말하는 거야? 카페에 있던 날? 힌트 조금만 줘ㅋㅋ” |
| 본문 | “아, 찻집에서 그림 그리던 날! 창가에 앉아서 그렸지ㅋㅋ” |
| 본문+이미지 설명 | “아 그날ㅋㅋ 창가에 스케치북 펼쳐 두고 그렸지. 느긋한 느낌이었어.” |

모호한 질문에서의 대화 복구 예시:

> 사용자: “아니 거기 말고, 야외에서 그렸던 날ㅋㅋ”
> 캐릭터: “아ㅋㅋ 내가 다른 날 생각했네. 공원 쪽 말하는 거야?”

이 예시는 처음부터 숨은 정답을 맞히기보다 정정을 수용하고 새 대상을 확인하는 요구를 보여준다. **실제 정정 → 다른 근거 탐색 → 새 대상 유지 능력은 아직 검증하지 않았다.** 기존 정적 질문의 결과를 이 요구의 성공 증거로 재사용하지 않는다.

## 5. 관측·비용·시간의 범위

실행 trace는 검색/embedding/text/tool/원자료 lookup, 실제 제공 source/annotation, 생략된 자료, cache replay/새 요청/unknown, 알려진 과금·예약, turn 처리 시간과 완료 상태를 구분한다. 별도 effort recorder는 Codex token·wall time을 기록하며 chatbot provider 비용과 섞지 않는다.

| 측정 run | 논리 provider port | 새 요청 / cache replay | 추가 확정 provider 비용 | run wall |
|---|---:|---:|---:|---:|
| 한국어 baseline | 81(text72/embed9) | 39 / 42 | $0.033541 | 468.444초 |
| 회상 run | 81(text71/embed10) | 54 / 27 | $0.066661 | 224.798초 |

회상 run의 새 unknown 예약은 **$0.010233**이다. 마지막 보존 ledger snapshot은 **991/1000요청, 누적 확정$0.374655 + 미확정 보수 예약$0.017858**, 총 한도US$1이다. 이때 잔여9요청이라는 수치는 해당 과거 snapshot의 한도에 대한 값이다. unknown 예약은 확정 청구액도0원 확정도 아니며 실제 제출 여부/요청 키를 보존하고 무단 재전송하지 않는다.

현재 코드/로컬 장부 한도는 별도 변경으로 US$2 / 10,000요청이다. 위 과거 run의 한도·측정치는 소급 변경하지 않으며 이 마감 작업에서는 외부 provider 호출·예산 변경·장부 초기화를 하지 않는다.

이 수치는 cache를 포함한 실제 개발 실행이다. 한국어 baseline 일부 기억 답변18개는 이전 동일 요청 cache였다. cache 없는 운영 단가/모델 순수 지연/서빙 throughput/전후 속도 개선으로 일반화하지 않는다. wall에는 로컬SQL·cache·대기·중단/복구 등이 포함되며 병렬 작업시간을 합산하지 않는다. 사람의 읽기·타이핑·관리 시간과 Codex dollar 청구액은 미측정이다. 회상 실행의 요청→계측 snapshot은31분8.108초, Codex4 lanes 관측합15,062,933 tokens(캐시 입력 부분집합 포함)이며 모델 run224.798초와 다른 범위다.

회상 당시 합성 전체 검증은252pass/28opt-in skip·typecheck/lint, 독립 SQL 감사45/45였다. SQL 통과는24세션/71턴·160visible messages, scope/재전송/예산·원자료 불변 검증이지 의미 정답률이 아니다. 현재 마감의 검증은281unit pass/28opt-in skip·typecheck/lint·웹 typecheck/build, 로컬 storage46pass·합성 UI6pass다. 실제 새 페르소나4명×3조건×2턴의 fake-only 로컬24턴/148assertion도 통과했으며 외부 provider0회다. fake 답변으로 개성/사실 정확도가 좋아졌다고 주장하지 않는다.

## 6. 기술 오류와 잔여 gate

보존 회상 run에서 인용 공백/줄바꿈 불일치가 서비스 안내5개, `off`의 미허용 도구 action이 실패1+후속skip1, 동일 unknown provider key가 두턴 실패로 관측됐다. unknown 외부 신규 제출은1번이며 동일 키를 재전송하지 않았다. 이것들은 허용 각색과 별개인 기술적 대화 끊김이다. 현재 마감 변경은 offsetless 인용의 유일한 ASCII 공백 차이만 원문으로 복원하고, 미허용 도구는 추가 호출 없는 서비스 안내로 끝내며, 미확정 외부 요청은 재전송 없이 안전한 오류 안내를 표시한다. DEV 자료 기반 4종 대화 설계를 새 페르소나 버전으로 등록하고 새 세션 catalogue에 연결했다. **이 문서의 과거 성공/실패 수치는 수정하지 않는다.** 새 변경은 합성/로컬 계약 검증이며 실제 모델의 새 품질 개선을 입증하지 않는다.

현재 방향:

1. **자료 정합성:** 확정 핵심 사건/주체/인용, 정정 후 모순을 본다.
2. **캐릭터 경험:** 자연스러운 회상·가벼운 각색·개성·정정 수용·맥락 연결·재미를 별도로 본다.


전체 3조건 재생성/전량 재채점은 현재 보류다. 합성·로컬 회귀 검증과 실제 모델 품질 평가를 구분한다. 사람 원자료·페르소나 의미 검수, 실인물 말투 충실도, 정정 후 복구, unseen 일반화, 주장별 의미 검증은 남은 한계다. 추가 유료 실험과 운영 배포는 이 마감의 완료 항목이 아니다.

### 새 페르소나의 차별화/검수 범위

- 미용 실험·실용 비교형, 따뜻한 일상·낮은 부담 제안형, 탐험·이야기 전개형, 분위기·시각 구성형의 4종 대화 설계다.
- DEV 캡션의 길이/emoji/hashtag·주제 cue 관찰과 작성한 대화 성격을 field provenance로 분리했다. 기존 ID·언어·AI 고지·경계와 원본 정의는 보존했다. 실제 내면/구어/고유 말투 충실도는 unknown이다.
- 새 immutable revision/current pointer만 원자적으로 등록하고 기존 세션은 이전 persona revision을 유지한다. 새 턴은 현재 runtime prompt를 사용하므로 과거 완료 turn의 prompt fingerprint와 구분한다.
- 유료 재테스트/새 품질 점수/사람 의미 검수는 하지 않았다. 생성/활성화 절차는 [페르소나 계약](persona-chat.md), 현재 서비스 처리 규칙은 [core 계약](../packages/core/README.md)을 따른다.

## 7. 재현·private 결과 위치

실제 자료 없이 계약 검증: 저장소 루트에서 `pnpm check`, 웹 build는 `pnpm build:web`, Python 합성 검증은 `make check`. DB/live 실행은 [runbook](runbook.md)의 loopback guard·명시 opt-in·기존 ledger를 따른다. 위 live run의 자료와 자격은 공개 fixture에 없으므로 공개 코드만으로 실제인물 측정 결과를 재생성할 수 없다. 문서 확인만을 위해 live 명령을 실행하지 않는다.

승인된 로컬 연구 환경에서만 확인 가능한 ignored 산출물:

- `reports/answer-regrading/`: 기존36 agent-loop 답변의 source-first reference/review/집계.
- `reports/korean-chat/latest.json`: 한국어 baseline; 같은 namespace의 frozen study/rubric/private reviews.
- `reports/recollection-chat/latest.json`: 별도 회상 run; report/preflight/실패 진단/회상·기억 리뷰/회계/SQL 검증. 이전 baseline pointer는 보존했다.
- `reports/goal1-finish/`와 `reports/persona-refinement/`: 마감의 버전/로컬 활성화·fake 계약 검증·자료 불변 근거.
- `reports/effort/`: 각 phase token/시간/회계 snapshot. 원문을 public Git에 복사하지 않는다.

계약 상세: [캐릭터 에이전트](character-agent.md) · [근거 평가](answer-evaluation.md) · [이미지 RAG](image-rag.md) · [원이미지 설명](image-descriptions.md) · [시간/토큰 계측](effort-accounting.md).
