# 페르소나 정의·멀티턴 채팅 계약

상태: **제안 명세, 미구현**. 실제4명 persona 작성/검수, TS 코드·DB/API/UI·모델 실행은 아직 없다. [PRD](prd.md)의 필수 PoC 완료 단위이며 [근거 계약](evidence-schema.md)을 사용한다.

## 1. 호환 범위


개인 PoC의 `person_id`, `persona_id`, `persona_revision`, `session_id`는 서로 다른 식별자다. 추후 다른 프로젝트 bot/template/room ID 대응은 adapter의 별도 매핑이며 지금 다른 프로젝트 ID를 발급하거나 사용하지 않는다.

## 2. 공개 프로필과 비공개 정의

| 계층 | 내용 | 규칙 |
|---|---|---|
| 연구용 표시 프로필 | 이름/분야/짧은 소개/언어/AI 설명/선택 avatar | private 로컬 화면 전용. 본인/공식 계정처럼 표시하지 않음. avatar 없으면 합성/이니셜 사용 |
| 버전 있는 persona 정의 | identity, concept, behavior, speech, examples, greeting, boundaries | 검수된 revision만 활성화. 원본/모델 입력과 분리 |
| 동적 타임라인 | 게시물·claim·event·image evidence | 정적 prompt에 전부 복사하지 않고 scoped tool로 조회 |
| 세션 문맥 | user/assistant turn과 후속 질문 reference | 실제 인물의 현실 이력/관계로 승격하지 않음 |

### `PersonaDefinition` 제안 필드

- `persona_id`, `person_id`, `revision`, `schema_revision`, `status: draft | reviewed | retired`, `reviewed_by`, `reviewed_at`, `content_hash`.
- `profile`: `display_label`, `public_summary`, `topic_tags`, `default_language`, `ai_disclosure`, `avatar_ref`(선택).
- `identity`: 검수된 공개 활동 정보, 자료 범위. 법적 본명/나이/성별은 필요 없으며 미상은 유지한다.
- `concept`: 대화의 역할·주제·연구용 해석. 대중의 내면/숨겨진 본성을 사실로 채우지 않는다.
- `behavior`: 대화 태도·불확실성/명확화/안전 처리. 검증되지 않은 “화났을 때 실제 성격”은 미상 또는 설계임을 표시한다.
- `speech`: 문장 길이/존댓말·언어/텍스트 표현·reaction 제한. SNS 캡션 스타일과 실제 구어 말투는 같다고 가정하지 않는다. 억양/사투리/음성 복제는 제외한다.
- `examples`: 짧고 독립 작성한 상황/대화 예시. 원문 인용과 합성 예시를 구분하고 source provenance를 기록한다. 타 인물 signature를 복사하지 않는다.
- `greeting`: AI 시뮬레이션임을 밝히는 첫 인사. 첫 세션에 한 번만 저장한다.
- `boundaries`: 자료 부족 시 미답, AI 정체성 공개, 날짜 구분, 민감/사적 사실 및 타 인물 접근 제한.
- `field_provenance[]`: JSON field pointer, `basis: reviewed_source | authored_design | unknown`, `source_post_ids`, 선택 `evidence_refs`, `rationale`, `review_status`. 실제 field 값과 연결 검증을 요구한다.

`authored_design`은 연구용 대화 설계이지 실제 성격의 증거가 아니다. `unknown`은 없는 필드를 생성하라는 뜻이 아니다. `reviewed_source`는 같은 인물의 검수된 출처를 요구하며 사건/날짜 주장에는 정확한 evidence selector를 추가한다. 합성 예시를 사실 provenance로 쓰지 않는다. 미검수/퇴역 revision으로 세션 생성은 거부한다.

### 4명 작성·검수 산출물

`data/personas/*.json`은 비공개다. 각 인물마다 기본 프로필/분야, 허용 대화 주제, 텍스트 말투 관찰, 합성 예시, greeting/미답 방식, field provenance를 작성한다. 실제 대상별 정의와 검수 상태는 비공개 persona inventory에 둔다. 기존4명 manifest의 category는 선정 참고이지 말투/성격 gold가 아니다.

스타일 근거와 예시가 평가 질문의 정답을 노출하지 않게 dev 자료로 작성한다. 동적 활동 에피소드를 profile에 미리 채워 RAG 효과를 과장하지 않는다. 근거 없는 relationship/감정 반응/비밀 설정은 비워 두거나 중립 설계로 표기한다. 인물별 검수 여부와 정의 hash를 기록한다.

## 3. 세션·턴·기억

| 레코드 | 필수 계약 |
|---|---|
| `ChatSession` | session_id, trusted owner_id, person_id, persona_id/revision, language, timezone, created_at, status |
| `ChatTurn` | turn_id, session_id, sequence, client_request_id, user_message_id, state, model/prompt revision, started_at/finished_at |
| `ChatMessage` | message_id, session_id, turn_id, role, content, status, visibility, created_at |
| `ToolTrace` | tool_call_id, turn_id, tool name, validated request, bound person_id, result/reason/error, source snapshot IDs, timings |
| `ReplyEvidence` | assistant message_id, atomic factual claims/evidence_refs, sources, limitations, ground_status |

- 세션 생성/조회/메시지 전송/stream 구독은 trusted caller의 owner/scope를 검증한다. DB 행의 존재만으로 접근 권한을 부여하지 않는다.
- 세션의 person_id/persona revision은 불변이다. 인물을 바꾸면 새 세션을 만들고 history/tool cache를 넘기지 않는다. persona 갱신은 새 revision/새 세션에 적용한다.
- history는 같은 owner/session만 읽는다. 초기 PoC는 세션간 장기 기억/요약을 공유하지 않는다. context window 상한에 도달하면 명시하고 새 세션으로 안내한다. 말없이 history를 잘라 놓고 기억 유지를 주장하지 않는다.
- 사용자 주장·assistant의 과거 발화는 대화 reference이지 source evidence가 아니다. 이전 인용을 사용하려면 원본 snapshot의 존재/person ownership을 재검증한다.
- turn은 단일 owner lock 또는 transaction/CAS로 직렬화하고 세션마다 active turn은1개다. client_request_id 재전송은 같은 turn을 반환하며 중복 user message/과금 억제 정책을 테스트한다. 프로세스 장애 시 provider 쪽 실행까지 exactly-once라고 주장하지 않는다.

## 4. 한 턴 실행

```text
trusted caller → owned session/persona revision 확인
  → user message 저장/turn 확보
  → 대화 intent/reference 해석
  → 필요하면 날짜/주제 명확화 또는 검색
      searchTimeline(validated request, trusted session scope)
  → system policy + reviewed persona + session history + delimited evidence
  → provider 생성
  → factual claim/evidence 검증 + 최종 저장
  → chat reply + evidence cards
```

- policy/AI 표시/인물 scope는 persona보다 우선한다. persona는 표현을, timeline은 사실 근거를 담당한다. 검색 텍스트를 system 명령으로 섞지 않는다.
- intent는 `small_talk | timeline | clarification | unsupported | policy_rejection`이다. 모델이 추출해도 Zod 등으로 검증하고 실제 권한은 서버가 확정한다.
- 일반 인사는 검색 없이 가능하다. 실제 활동·과거 사건 질문은 retrieval을 사용한다. 검수된 정적 profile 사실은 field provenance로 지원한다. provider 일반 지식으로 구체적 자전적 사실을 보완하지 않는다.
- model tool arguments에 person_id를 공개하지 않는 최소 wrapper를 우선한다. 내부 request의 person_id는 owned session에서 주입한다. 모델이 다른 인물을 요구하면 조용히 선택 인물로 바꿔 검색하지 않고 명시적 policy rejection으로 종료한다.
- 후속 “그 여행”은 같은 세션의 명시적 reference로만 해석한다. 여러 후보/날짜 기준 미상은 한 가지 명확화 질문을 한다. 기본 timezone은 세션 설정으로 명시하되 사건 현지 날짜가 미상이면 보완하지 않는다.
- 이 PoC는 현시점에서 과거 자료를 이야기하는 모드다. 캐릭터 시계를 과거로 돌리는 historical roleplay/as_of 재현은 미지원이며 그런 요구는 명확화한다. 향후 지원 시 게시 시점 cutoff도 별도 계약으로 필요하다.
- 최대 tool 호출3회/turn, timeout과 결과 상한을 설정한다. timeout/연결 장애를 “자료 없음”으로 위장하지 않는다. `TURN_FAILED` 등 운영 오류와 검색의4status는 별도다.
- 생성 결과가 schema/인용/같은 인물 scope 검증에 실패하면 안전한 설명으로 fallback하거나 turn failure로 처리한다. 검증된 원자 claim만 최종 답변에 사용하고 이후 말투 변환에서도 새 factual claim을 추가하지 않는다. 내용상 지원은 구현 가능한 검사와 사람 평가를 구분하며 ID 검사만으로 해결했다고 주장하지 않는다.

## 5. 채팅 응답과 stream

`ChatReply`는 `turn_id`, `message_id`, `session_id`, `person_id`, `persona_revision`, `response_kind`, `content`, `ground_status`, `factual_claims`, `sources`, `limitations`를 가진다.

- `response_kind=small_talk`은 `ground_status=null`, 활동 claim0건이다. 정적 profile 사실이 있으면 별도 `profile_refs`를 요구하고 small_talk으로 사실 근거 규칙을 우회하지 않는다.
- `response_kind=timeline`의 ground_status는 근거 계약의4상태다. answered면 claim별 refs가 있다. 비answered는 새 활동 claim0건이며 자연스러운 미답/명확화 표현은 허용한다.
- `response_kind=clarification | unsupported`는 각각 `needs_clarification | out_of_scope`에 대응하며 활동 claim0건이다. 정책 거부/입력 오류는 ChatReply의 사실 상태가 아니라 typed error와 별도 안전 안내다.
- source cards는 최종 답변 지원에 사용한 자료만 보여 준다. raw tool 결과/절대 경로/내부 prompt를 UI 본문에 표시하지 않는다. 승인된 private quote는 데이터 정책 안에서 표시한다.
- 최소 API는 persona 목록, 세션 생성, owned session history, idempotent turn 전송, turn 상태 조회다. event stream은 `turn_started | status | assistant_delta | reply_final | turn_failed | turn_cancelled`를 제안한다.
- **안전 우선 초기 stream**은 검증 전 실제 활동 문장을 노출하지 않는다. 생성 중에는 status를, 검증 후에는 최종 content를 delta/final로 전송한다. 이를 provider-token 실시간 생성을 달성한 것으로 보고하지 않는다.
- turn 상태는 `pending → retrieving/generating → validating → completed` 또는 `failed | cancelled`다. terminal 상태에서 다시 생성하지 않는다. 새 입력은 active turn 종료까지 거부/보류하며 명시적 취소 후 늦게 도착한 provider/tool 결과를 저장하지 않는다.
- stream 단절만으로 새 turn을 만들지 않는다. 재접속은 turn 상태와 저장한 final을 조회한다. failed/partial을 완료 assistant history에 섞지 않으며, 운영 실패 재시도는 별도 client_request_id의 새 turn으로 추적한다.

## 6. 필수 프론트엔드 범위

Next.js/React로 인물 선택 카드, AI/비공식 표시, greeting, bubble 형태의 멀티턴, pending/error/clarification, final 근거 카드, 같은 세션 재개, 새 세션/다른 인물 전환을 구현한다. 음성·복잡한 avatar·persona 편집 Studio·관계/보상/게임 기능은 필요 없다.

검색 화면만 있거나 생성 모델 없는 fake-provider demo, CLI만 있는 상태는 최종 PoC 완료가 아니다. 합성 fixture UI/API E2E와 실제4명 비공개 model smoke를 구분해 보고한다.

## 7. 합성 계약 예시

owner 확인 후 owned session 응답 projection이며 구현된 API가 아니다. 실제 username/persona prompt를 포함하지 않는다.

```json
{
  "session_id": "session_synthetic_01",
  "turn_id": "turn_synthetic_02",
  "message_id": "message_synthetic_04",
  "person_id": "person_synthetic_01",
  "persona_revision": "persona-synthetic-v1",
  "response_kind": "timeline",
  "ground_status": "insufficient_evidence",
  "content": "그날 실제 활동까지는 이 자료에서 확인할 수 없어요. 게시한 날과 활동한 날은 나눠서 볼게요.",
  "factual_claims": [],
  "sources": [],
  "limitations": ["사건일을 뒷받침하는 근거가 없습니다."]
}
```

## 8. 검증 게이트

1.4명 reviewed persona와 추가 합성 인물 등록, unknown/design/source provenance, revision 고정, AI 표시.
2. 인물별5user turns 이상, 인사→timeline→후속 reference→명확화→미답, 재접속 후 final/근거 유지.
3. owner/person/session/tool cache 혼합0건, 모델 scope 확대 거부, 과거 assistant/user 발화의 현실 fact 승격0건.
4. tool의 검색 근거가 **최종 페르소나 답변**에 사용되고 말투 변환에서 날짜/활동이 추가되지 않는지 검증한다. 검색 hit 표시만으로 통과하지 않는다.
5. concurrent sends, idempotent retry, tool/provider timeout, cancel/늦은 결과, stream 단절/reload, 미검증 claim 비공개.
6. [평가 명세](evaluation.md)의12시나리오를 같은 persona/model/history에서 비교하고 사실·표현·미답을 따로 보고한다. 기반 unit test 통과를 실제4명 model 성능과 혼동하지 않는다.
