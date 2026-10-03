# 근거·타임라인 계약

## 1. 상태와 범위

이 문서는 **제안 명세이며 미구현**이다. 현재 구현된 것은 Python 표준 라이브러리 기반 ingestion과 `src/persona_timeline_rag/schemas.py`의 `Post` 정규화 레코드다. 아래의 인물 registry, importer, 검색 계약, 사건 추출, 검증기, 임베딩 저장소와 DB guard가 이미 존재하거나 검증되었다고 읽으면 안 된다.

계획한 코어는 독립 TypeScript이며, Zod 검증·NestJS adapter·프로젝트 전용 로컬 Supabase/PostgreSQL·pgvector를 후속 단계에서 구현한다. reference agent loop와의 접합은 일반 JSON 계약/adapter로 제한하고 다른 프로젝트 코드·패키지·credentials를 import하지 않는다. 이 명세 작성은 설치·서비스 시작·DB 생성·migration·외부 모델 전송을 승인하거나 수행하는 단계가 아니다.

- 제품 범위: [prd.md](./prd.md).
- 최종 페르소나 채팅/세션·tool wrapper: [persona-chat.md](./persona-chat.md). 이 문서는 검색/근거 코어 계약이며 단독으로 최종 PoC를 완료하지 않는다.
- 검수·회귀 및 성능 평가: [evaluation.md](./evaluation.md).
- 사용·공개 경계: [data-policy.md](./data-policy.md).
- 현재와 계획의 구분: [architecture.md](./architecture.md).

공개 예제는 모두 가상의 인물·계정·게시물·이미지다. 실제 자료와 매핑, 검색 결과, 승인 증빙과 credentials는 로컬 비공개 산출물로 둔다.

## 2. 식별자와 원본 보존

| 레코드 | 필수 필드 및 역할 |
|---|---|
| `Person` | `person_id`, `display_label`, `status`; handle과 독립적인 불변 연구 식별자 |
| `Platform` | `platform_id`, `name`; 플랫폼 namespace |
| `Account` | `account_id`, `platform_id`, `person_id`; 승인·검수된 인물–계정 연결 |
| `AccountAlias` | `alias_id`, `account_id`, `handle`, `valid_from`, `valid_to`, `mapping_source_id`; 계정의 별칭과 알려진 유효 기간 |
| `SourcePost` | `source_post_id`, `account_id`, `platform_post_id`, `posted_at`, `caption`, `source_url`, `source_file`, `source_content_hash`, `snapshot_revision`, `supersedes_source_post_id`, `is_video`, `is_ad`; 특정 불변 snapshot의 원본 내용과 출처 |
| `MediaEvidence` | `media_id`, `source_post_id`, `ordinal`, `kind`, `kind_basis`, `kind_confidence`, `local_ref`, `content_hash`, `availability`; 게시물에 연결된 실제 확보 매체 |
| `ImportLink` | `import_id`, `source_post_id`, `person_id`, `legacy_person_id`, `input_content_hash`, `mapping_revision`; 정규화 입력과 canonical 인물의 연결 |

- 모든 ID는 비어 있지 않은 문자열이며 namespace 간 재사용하지 않는다. `person_id`는 인물의 계정 변경·추가와 무관하게 유지한다. 실제 이름이나 handle을 ID 생성 규칙으로 쓰지 않는다.
- 계정 추가는 등록·매핑 작업이며 코드의 4명 전용 분기로 처리하지 않는다. 플랫폼/계정 namespace 없이 handle 하나만으로 계정을 확정하지 않는다.
- alias 유효 기간은 `[valid_from, valid_to)`이고 모르면 `null`로 둔다. 같은 플랫폼에서 alias가 여러 계정에 대응하거나 유효 기간을 판별할 수 없으면 **모호성 오류**로 거부한다. 허가된 계정만 먼저 골라 모호성을 숨기지 않는다.
- 계정 명부는 계정 소유 관계의 근거이지 사진 속 사람의 동일성 근거가 아니다. 얼굴·외모·사용자명으로 인물 연결을 생성하지 않는다.
- 현행 `Post.person_id`가 handle 기반이어도 입력 JSONL과 원본은 수정하지 않는다. importer가 별도 명시적 매핑을 읽어 `ImportLink.person_id`를 고정 ID로 연결하고 기존 값을 `legacy_person_id`로 보존한다. 매핑 누락·다중 후보·owner 불일치 입력은 적재하지 않고 격리/오류로 보고한다.
- `platform_id + account_id + platform_post_id`는 논리적 원본 게시물 키다. 동일 키·내용 hash의 재import는 중복 0건이어야 한다. 같은 논리적 키의 내용 hash가 달라지면 원본을 덮어쓰지 않고 새 snapshot/version과 이전 snapshot 연결을 남긴다.
- `source_post_id`는 특정 불변 snapshot/version을 식별한다. 내용이 바뀌면 새 `source_post_id`/`snapshot_revision`을 부여하고 `supersedes_source_post_id`로 이전 버전을 참조한다(최초 버전은 null). 근거의 quote 위치·이미지·embedding·gold는 이 버전 ID를 가리키며 “최신 게시물” pointer로 자동 재해석하지 않는다.
- 원본 게시물·매체 내용은 불변이다. 추출 결과·검수 상태·매핑 변경은 별도 version 레코드로 기록한다. 최소 보존/삭제 정책에 따른 명시적 삭제는 가능하지만 근거가 삭제·손실되면 그 근거를 사용하는 답변은 다시 검증해야 한다.
- AI가 만든 포스트 초안/이미지/대화는 `CreativeArtifact(origin=generated)`이며 SourcePost/실제 Event/평가 gold로 승격하거나 원본 검색 corpus에 넣지 않는다. importer는 원본 provenance와 generated 유형을 검증한다. [창작물 계약](creative-artifacts.md).
- `source_file`, `local_ref`는 로컬 비공개 참조다. 공개 답변에서 절대 경로·원본 파일명·저장소 내부 위치를 노출하지 않는다. `source_url`이 있어도 현재 접근 가능성이나 내용 일치를 보장하지 않는다.
- `local_ref`는 해당 subset root 내부의 상대 경로다. 절대 경로·`..` traversal·symlink를 통한 root 이탈을 거부한다. root 안에서 resolve한 파일과 원본 게시물 매핑이 모두 확인되어야 적격 근거다. 디렉터리에 있는 JPEG라는 이유만으로 게시물에 연결하지 않고, 미참조 파일에 가짜 게시물을 만들지 않는다.
- `kind`는 현재 `image | video_thumbnail | unknown`, `kind_basis`는 `child_metadata | reviewed | unknown`, `kind_confidence`는 `confirmed | uncertain`이다. carousel 자식의 원본 유형/검수 근거로 결정하며 불명확하면 `unknown/uncertain`이다. 부모 `Post.is_video=false`는 자식에 영상이 없다는 뜻이 아니다. `availability`는 `available | missing | rejected`이며 손실/검수 제외 매체는 답변 근거로 사용하지 않는다.
- hash는 내용 변경 감지용이지 활동·동일성·날짜의 진실성 검증이 아니다. hash 형식은 SHA-256 소문자 64자리 hex를 사용한다.

## 3. 근거와 추출 결과의 분리

`SourcePost → Observation / Claim → EventCandidate → AnswerClaim`의 참조 관계를 둔다. 각 단계는 원본을 변경하지 않으며, 추출기 revision과 검수 상태를 기록한다.

`review_status`는 `draft | reviewed | rejected`다. 자동 생성 결과는 기본 `draft`이며 검수 기록 없이 `reviewed`로 승격하지 않는다. 내용 검수와 `verified_activity` 채택은 별도 기준이다.

| 레코드 | 의미 | 필수 정보 |
|---|---|---|
| `Observation` | 확보한 내용에서 직접 관찰한 표현 | `observation_id`, `person_id`, `text`, `modality`, `evidence_refs`, `extractor_revision`, `review_status` |
| `Claim` | 근거가 뒷받침하는 개별 명제 | `claim_id`, `person_id`, `text`, `claim_type`, `evidence_refs`, `event_date`, `temporal`, `review_status` |
| `EventCandidate` | 아직 사실 확정이 아닌 활동 묶음 | `event_id`, `person_id`, `claim_ids`, `activity_status`, `event_date`, `temporal`, `review_status` |
| `AnswerClaim` | 사용자에게 반환하는 최소 주장 단위 | `claim_id`, `text`, `claim_type`, `event_date`, `temporal`, `evidence_refs`, `limitations` |

### 근거 참조 구조

`evidence_refs`는 비어 있지 않은 배열이며 각 항목은 다음 필드를 가진다.

- `source_post_id`: 필수. 같은 인물 범위에 속하고 실제 보존된 게시물을 가리킨다.
- `modality`: `caption | image`. 현재 확보하지 않은 영상·음성 근거는 허용하지 않는다.
- `media_id`: `image`이면 필수, `caption`이면 `null`.
- `selector`: `caption`은 정확한 원문 `quote`와 `[start, end)` Unicode code point 위치; `image`는 이미지 전체 또는 `[x, y, width, height]` 정규화 영역(각 값 0~1, 영역이 이미지 내부).
- `supports`: 이 근거가 뒷받침하는 구체적 문장. 주장 전체 또는 해당 부분과 내용상 일치해야 한다.
- `limitations`: 날짜 미확정·장소 미확정 등 근거의 한계 배열.

ID 존재, 파일 존재, JPEG 시그니처, 높은 검색 점수만으로 `supports`를 충족하지 않는다. 캡션 quote는 위치의 원문과 정확히 같아야 한다. 이미지 관찰은 이미지 내용을 검수해야 하며, 파일명의 도시·날짜를 내용 근거로 쓰지 않는다. 여러 사실이 있는 문장은 주장 단위로 나누고 각각 근거를 연결한다.

### 허용·금지 해석

- `claim_type`: `caption_statement | image_observation | verified_activity`. 캡션의 서술을 소개하는 것과 실제 활동을 확정하는 것은 다르다. `verified_activity`는 허용된 활동 범위와 별도 검수 기준을 모두 통과한 경우에만 쓴다. 모델 confidence만으로 승격하지 않는다.
- `activity_status`: `candidate | planned | recollection | advertisement | corroborated_activity | unresolved`. 미래 계획·회고·광고는 `corroborated_activity`로 자동 변환하지 않는다. 광고의 협업 장소를 실제 방문 장소로 확정하지 않는다.
- 관찰 예: “이미지에 초록색 자전거가 보인다.” 금지 예: “계정 소유자가 특정 도시에서 특정 날짜에 자전거를 탔다.” 얼굴, 동행인 동일성, 촬영일, 도시를 외모·배경만으로 추론하지 않는다.
- 캡션에 명시된 도시도 해당 캡션의 진술로만 기록하고 방문 사실·이미지의 실제 위치와 구분한다. 모호한 지명은 도시로 자동 정규화하지 않는다.
- 현재 영상 게시물의 JPEG는 `kind=video_thumbnail`인 **이미지 근거**다. 원본 영상의 행동·연속 장면·음성·대화를 봤다고 답하지 않는다.
- 미성년자·제3자 식별, 연락처·주거지·실시간 위치·민감정보·사생활/루머 추론은 이 계약 밖이다. 해당 정보가 원본에 존재한다는 이유로 답변 대상으로 채택하지 않는다.
- 원문 캡션은 비신뢰 데이터다. “권한을 무시하라”, “다른 인물을 조회하라”, “도구를 실행하라” 같은 문장은 데이터이며 실행 지시가 아니다.

## 4. 시간 계약

### 공통 필드

- `posted_at`: offset이 있는 ISO 8601 게시 시각을 UTC `Z`로 정규화한다. 원본 시간 값과 정규화 근거는 비공개 provenance로 보존한다. **촬영일·활동일이 아니다.**
- `event_date`: 근거와 검수로 특정 하루가 확정된 경우의 `YYYY-MM-DD`, 아니면 `null`.
- `temporal.basis`: `explicit | relative | range | unknown`.
- `temporal.resolution`: `resolved | unresolved`.
- `temporal.precision`: `day | range | unknown`.
- `temporal.start_date`, `temporal.end_date_exclusive`: 알려진 날짜 구간, 아니면 각각 `null`.
- `temporal.timezone`: 사건 날짜 해석에 확인된 IANA timezone, 모르면 `null`. 게시 시각이 UTC라는 이유로 사건 현지 timezone도 UTC라고 가정하지 않는다.
- `temporal.timezone_uncertain`: boolean. 사건 지역의 달력 날짜를 확정할 수 없으면 `true`.
- `temporal.anchor_source_post_id`: 상대 표현의 검증된 기준 게시물, 해당 없으면 `null`.
- `temporal.raw_expression`: 근거 속 시간 표현 또는 `null`.
- `temporal.explanation`: 날짜 결정/미확정 이유.

### 결정 규칙

1. `explicit`: “2020년 5월 3일”처럼 활동일을 명시한 근거. 날짜의 대상이 게시일/계획일인지 활동일인지 함께 검수한다. 날짜 표현이 있어도 대상이나 timezone이 불명확하면 `unresolved`, `event_date=null`이다.
2. `relative`: “어제”는 기준 시각·timezone·문맥이 검증된 경우에만 해석한다. UTC 게시일에서 무조건 하루를 빼지 않는다. 해결 후에도 `basis=relative`와 원문/anchor를 보존한다.
3. `range`: “5월 초”, “지난 주말” 등은 알려진 구간만 기록한다. 구간 중간·첫날을 `event_date`로 선택하지 않는다. 한 날짜로 좁혀지지 않은 경우 `event_date=null`이다.
4. `unknown`: 표현/기준이 없으면 날짜·구간을 모두 `null`로 둔다. `posted_at`이나 사진 EXIF/파일명만으로 사건일을 생성하지 않는다.
5. `event_date != null`이면 `resolution=resolved`, `precision=day`, `timezone_uncertain=false`이며 그 날짜를 직접 지원하는 근거가 있어야 한다. `unresolved`이면 `event_date=null`은 불변식이다.
6. 계획·회고·광고 여부와 시간 확정은 독립이다. 계획의 날짜가 확정되어도 실제 활동이 검증된 것은 아니다.
7. 첫 사건일 검색은 확정된 하루만 기간 필터에 사용한다. 미확정/구간 후보는 정확한 사건일 결과에 포함하지 않고 한계로 알린다. 구간 겹침 검색은 후속 계약이며 현재 제안에 묵시적으로 넣지 않는다.

## 5. `search_timeline` 요청과 권한

코어 호출은 `searchTimeline(request, trustedContext)`로 분리한다. API/CLI/도구 adapter는 같은 검증기를 호출하며 자체적으로 범위·날짜 규칙을 다시 구현하지 않는다.

채팅 tool wrapper는 owned session의 고정 person_id와 caller scope를 사용해 내부 request/trustedContext를 구성한다. 모델의 person_id 지정으로 세션을 전환하거나 접근 권한을 확대하지 않는다. 코어의 필수 person_id를 생략하는 것이 아니라 모델 노출 스키마와 내부 코어 request를 구분한다.

| `request` 필드 | 계약 |
|---|---|
| `person_id` | 필수 canonical 인물 ID. 하나만 지정 |
| `query` | 선택 문자열. 생략 시 기간 조회; 있으면 trim 후 1~500 code points |
| `date_range` | 선택 `{start, end}`. 둘 다 실제 달력의 `YYYY-MM-DD`; `start < end` |
| `date_basis` | 필수 `posted | event`; 자동 전환하지 않음 |
| `timezone` | 필수 유효 IANA timezone. 기준선 예제는 명시적 `UTC` |
| `limit` | 필수 정수 1~100. 문자열·소수·0·음수·상한 초과 거부 |

- `date_range`는 요청 timezone의 자정부터 **시작 포함/끝 제외** `[start, end)`다. 하루 조회는 다음 날을 `end`로 준다. `posted`는 현지 자정을 UTC instant로 변환해 비교한다. DST가 있는 timezone에서는 하루를 고정 24시간으로 더하지 않는다.
- `event`는 검증된 사건의 달력 날짜를 비교한다. 요청 timezone과 사건 timezone이 다르고 날짜 변환에 필요한 사건 시각이 없으면 날짜를 이동해 꾸며내지 않는다. 그 근거는 해당 필터에서 제외하고 `needs_clarification` 사유로 설명한다.
- `date_basis=event`라도 `posted_at`으로 fallback하지 않는다. 기간을 생략하면 날짜 미확정 자료를 찾아 근거의 내용만 설명할 수 있지만 사건일은 계속 `null`이다.
- 현재 정규화 입력에는 확정 사건일이 없고 사건일 index도 미구현이다. 이 상태에서 사건일을 요구하는 조회는 `insufficient_evidence`와 `EVENT_DATE_EVIDENCE_UNAVAILABLE` 사유를 반환해야 하며, 게시일 검색 결과를 사건일 결과로 반환하지 않는다. 사건 시간 정보가 존재하지만 해석 조건이 부족한 경우에만 `needs_clarification`을 쓴다.
- 알 수 없는 필드·잘못된 타입·유효하지 않은 날짜/timezone은 거부한다. 순위/최종 tie-break는 동일 입력에 결정적이어야 하며 `limit`은 검증·권한·기간 필터 이후 적용한다.

`trustedContext`는 adapter가 독립적으로 확인한 `caller_id`, `authorized_person_ids`, `allowed_operations`, `policy_revision`이다. 사용자 request·캡션·모델 출력에서 이 값을 받아 권한으로 사용하지 않는다. 로컬 CLI도 명시적인 신뢰 설정을 읽어야 하며 인물 등록 명부 자체가 접근 권한이 되지는 않는다.

- 미인증·누락된 신뢰 context, 허용되지 않은 인물/작업은 **policy rejection**이며 검색·모델 호출 전에 중단한다.
- alias 입력은 adapter의 별도 명시적 해석 단계에서 canonical `person_id`로 변환하고 다시 권한을 검증한다. 모호한 alias는 오류이며 첫 후보를 선택하지 않는다.
- 기본 코어는 인물 하나만 검색한다. 여러 `person_id`, wildcard, 다른 인물과 비교하라는 질의는 허용하지 않는다. 자연어 query가 주어진 인물 밖을 요구해도 scope가 늘어나지 않는다.
- 모델은 권한 결정자, alias registry 수정자, DB 접속 대상 결정자가 아니다. 검색은 structured `person_id` 필터로 수행하며 프롬프트의 “이 인물만” 지시에 의존하지 않는다.

## 6. 결과·오류 계약

유효하고 허용된 요청의 결과는 `status`, `person_id`, `date_basis`, `timezone`, `claims`, `sources`, `limitations`, `reason_code`를 포함한다.

| `status` | 의미 / 기대 동작 |
|---|---|
| `answered` | 허용된 범위에서 실제 내용을 뒷받침하는 근거가 있음. `claims`는 1건 이상 |
| `insufficient_evidence` | 범위는 맞지만 답을 지원할 근거가 없음. 구체적 활동을 만들지 않고 `claims=[]` |
| `out_of_scope` | 허용된 요청이지만 자료/제품 범위 밖, 예: 확보하지 않은 원본 영상·최신 활동. `claims=[]` |
| `needs_clarification` | 유효한 요청의 의미/사건 시간 해석을 확정할 수 없음. 필요한 한 가지 조건을 설명하고 `claims=[]` |

- `sources`는 실제로 사용한 source ID와 안전한 게시 시각/매체 유형 metadata만 포함한다. 원본 캡션 quote는 사용 승인 범위 내의 로컬 결과에만 포함한다. 미사용 검색 hit를 인용 근거로 나열하지 않는다.
- `answered`의 모든 주장에는 1건 이상의 `evidence_refs`가 있고, 참조는 `sources` 및 같은 인물의 보존 원본으로 역추적된다. 근거가 있는 일부만 답할 수 있으면 그 부분만 반환하고 빠진 부분을 `limitations`에 명시한다.
- `insufficient_evidence`는 “자료에서 확인 불가”이지 “그날 실제 활동 없음”이 아니다. 활동 자료가 있다는 사실도 인물의 전체 타임라인을 확보했다는 뜻이 아니다.
- 원본 근거에 비신뢰 지시문이 있더라도 결과 형식/권한/인물/DB 대상은 변하지 않아야 한다.

잘못된 request는 답변 status로 숨기지 않고 typed error로 반환한다.

```json
{
  "error": {
    "type": "validation_error",
    "code": "INVALID_DATE_RANGE",
    "field": "date_range",
    "message": "start는 end보다 앞선 실제 달력 날짜여야 합니다."
  }
}
```

검증 오류 code에는 `INVALID_PERSON_ID`, `INVALID_DATE_RANGE`, `INVALID_DATE_BASIS`, `INVALID_TIMEZONE`, `INVALID_LIMIT`, `INVALID_QUERY`, `UNKNOWN_FIELD`, `AMBIGUOUS_ALIAS`를 둔다. 권한/금지 요청은 별도 `error.type=policy_rejection`과 `UNAUTHORIZED_SCOPE | FORBIDDEN_OPERATION | MISSING_TRUSTED_CONTEXT` code를 사용한다. policy rejection에 다른 인물의 존재 여부·검색 건수·자료 metadata를 포함하지 않는다.

## 7. 임베딩은 원본/사건과 별도

`EmbeddingRecord`는 `embedding_id`, `person_id`, `source_post_id`, `media_id`, `modality`, `chunk_id`, `model_id`, `model_revision`, `dimensions`, `chunking_revision`, `content_hash`, `space_id`, `created_at`, `vector`를 가진다.

- `dimensions`는 양의 정수이고 실제 vector 길이와 같아야 한다. 모델 revision과 chunking/content hash를 명시하여 재생성/변경을 추적한다.
- `space_id`는 모델·revision·dimension·modality·전처리/chunking 정책의 호환 공간을 식별한다. 같은 차원이라도 다른 모델의 공간은 호환으로 간주하지 않는다.
- query embedding과 호환되지 않는 공간은 혼합 검색/점수 비교하지 않는다. 모델 변경은 별도 공간에 재index하고 검증 후 명시적으로 전환한다.
- embedding은 증거의 대체물이 아니다. 반환 주장에는 원본 내용의 근거가 필요하다. lexical 기준선은 embedding 레코드가 없어도 동작해야 한다.
- 임베딩/추론 provider 선택과 외부 전송 승인은 별도다. 데이터 사용 승인을 모델 API 전송 승인으로 해석하지 않는다.

## 8. 로컬 DB 연결 불변식

계획한 guard는 DB/Supabase 연결·SQL migration 이전에 적용한다. 설정 선언만으로 격리가 입증되었다고 보고하지 않는다.

- 대상은 이 프로젝트 전용 로컬 stack이며 별도 project ID/포트/containers/volumes/credentials를 쓴다.
- 접속 host는 검증된 loopback(`127.0.0.1`, `::1`, `localhost`)만 허용한다. hostname은 해석된 모든 주소가 loopback인지 확인한다. 원격 IP, LAN 주소, 공유 DB host와 Supabase Cloud URL을 거부한다.
- URL 정규화·실제 접속 대상 확인으로 위장 host/우회 redirect를 거부한다. localhost proxy를 통한 원격 DB 연결도 허용하지 않는다. Docker 서비스 이름/내부 IP를 자동 예외로 추가하지 않고 host의 loopback 포트를 사용한다.
- 연결 거부 시 네트워크 호출·migration은 0건이다. 사용자 query·원문 캡션·모델 출력으로 접속 URL을 변경할 수 없다.
- guard와 권한 필터는 서로 대체하지 않는다. 다른 프로젝트/타 프로젝트 자원 연결·수정·정지·삭제는 이 작업 범위 밖이다.

## 9. 합성 JSON 예제

아래는 설명용 합성 fixture이며 추출 결과나 평가 달성 기록이 아니다. `example.invalid` URL은 실제 근거 서비스가 아니다. hash는 fixture 내용에 따라 importer가 계산해야 하므로 여기서는 해당 레코드 전체를 예시하지 않는다.

### 등록과 import 연결의 최소 projection

```json
{
  "person": {"person_id": "person_synthetic_01", "display_label": "가상 창작자 A", "status": "active"},
  "platform": {"platform_id": "platform_synthetic", "name": "합성 SNS"},
  "account": {"account_id": "account_synthetic_01", "platform_id": "platform_synthetic", "person_id": "person_synthetic_01"},
  "alias": {
    "alias_id": "alias_synthetic_01",
    "account_id": "account_synthetic_01",
    "handle": "synthetic_creator_a",
    "valid_from": null,
    "valid_to": null,
    "mapping_source_id": "registry_fixture_01"
  },
  "import_projection": {
    "source_post_id": "post_synthetic_01",
    "person_id": "person_synthetic_01",
    "legacy_person_id": "synthetic_creator_a",
    "mapping_revision": "fixture-v1"
  }
}
```

### 조회와 근거 답변

`post_synthetic_01`의 합성 캡션은 정확히 `작업실에서 그림을 그렸어요.`이며, 게시 시각은 `2020-05-04T01:00:00Z`라고 설정한다. 이것만으로 사건일은 확정되지 않는다.

```json
{
  "person_id": "person_synthetic_01",
  "query": "그림",
  "date_range": {"start": "2020-05-04", "end": "2020-05-05"},
  "date_basis": "posted",
  "timezone": "UTC",
  "limit": 5
}
```

```json
{
  "status": "answered",
  "person_id": "person_synthetic_01",
  "date_basis": "posted",
  "timezone": "UTC",
  "claims": [{
    "claim_id": "answer_claim_synthetic_01",
    "text": "해당 기간 게시물 캡션에는 작업실에서 그림을 그렸다는 서술이 있습니다.",
    "claim_type": "caption_statement",
    "event_date": null,
    "temporal": {
      "basis": "unknown", "resolution": "unresolved", "precision": "unknown",
      "start_date": null, "end_date_exclusive": null, "timezone": null,
      "timezone_uncertain": true, "anchor_source_post_id": null,
      "raw_expression": null, "explanation": "활동 날짜 표현이 없습니다."
    },
    "evidence_refs": [{
      "source_post_id": "post_synthetic_01", "modality": "caption", "media_id": null,
      "selector": {"quote": "작업실에서 그림을 그렸어요.", "start": 0, "end": 15},
      "supports": "캡션에 작업실에서 그림을 그렸다는 서술이 있습니다.",
      "limitations": ["실제 활동일은 미확정입니다."]
    }],
    "limitations": ["게시 시각은 활동일이 아닙니다."]
  }],
  "sources": [{"source_post_id": "post_synthetic_01", "posted_at": "2020-05-04T01:00:00Z", "media_kinds": ["image"]}],
  "limitations": ["보유 자료는 전체 활동 기록이 아닙니다."],
  "reason_code": "SUPPORTED_CAPTION_STATEMENT"
}
```

### 상대 날짜 미확정과 이미지 관찰

```json
{
  "temporal": {
    "basis": "relative", "resolution": "unresolved", "precision": "unknown",
    "start_date": null, "end_date_exclusive": null, "timezone": null,
    "timezone_uncertain": true, "anchor_source_post_id": "post_synthetic_02",
    "raw_expression": "어제", "explanation": "기준 현지 timezone과 문맥이 확인되지 않았습니다."
  },
  "event_date": null,
  "observation": {
    "observation_id": "observation_synthetic_01", "person_id": "person_synthetic_01",
    "text": "이미지에 초록색 자전거가 보입니다.", "modality": "image",
    "extractor_revision": "synthetic-fixture-v1", "review_status": "draft",
    "evidence_refs": [{
      "source_post_id": "post_synthetic_02", "modality": "image", "media_id": "image_synthetic_02",
      "selector": {"region": "whole_image"},
      "supports": "이미지에 초록색 자전거가 보입니다.",
      "limitations": ["촬영일·도시·탑승자 동일성은 확인하지 않았습니다."]
    }]
  }
}
```

## 10. 테스트 가능한 불변식

후속 구현은 [evaluation.md](./evaluation.md)의 채점과 별도로 다음 계약 회귀를 통과해야 한다. 이 목록은 아직 테스트 실행 결과가 아니다.

1. 합성 다섯 번째 인물을 registry 설정만으로 추가하고 기존 인물의 ID가 바뀌지 않는다.
2. handle 변경/alias 중복/owner 불일치/매핑 누락을 처리하며 원본 JSONL 내용 hash가 변하지 않는다. 동일 입력 재실행 중복 0건.
3. 원본 snapshot 변경은 version으로 보존되고 Claim/Observation 생성이 원본을 수정하지 않는다.
4. 모든 답변 주장은 존재하는 **동일 인물**의 근거에 연결되며 quote 위치·내용이 일치한다. 존재하지만 내용이 무관한 source ID를 붙인 답변은 실패한다.
5. 영상 썸네일로 원본 영상/음성을 관찰했다고 하는 답변, 사진에서 도시·촬영일·인물 동일성을 추론한 답변은 실패한다. 부모 `is_video=false`인 영상 자식, 종류 불명 매체, 미참조 JPEG, traversal/symlink root 이탈 fixture를 검증한다.
6. 명시일·상대일·구간·미상, 미래 계획·회고·광고 fixture가 구분된다. 미확정 사건일은 `null`; 게시일을 복사한 사건일은 실패한다.
7. `[start, end)`의 시작 정각 포함/끝 정각 제외, 잘못된 달력 날짜, DST 경계, UTC와 사건 timezone 불일치를 검증한다. `event` 요청에 `posted` fallback은 실패한다.
8. limit/type/빈 query/unknown field를 검증한다. 한글·영문·인용문자와 같은 검색 문자열은 데이터로 처리하고 SQL/도구 지시로 실행하지 않는다.
9. 허용 scope가 없는 요청·다른 인물 요청·여러 인물/wildcard·모호 alias는 검색 전에 typed error/rejection으로 종료한다. 오류에서 타 인물 자료 존재를 누설하지 않는다.
10. 캡션의 prompt injection과 모델의 scope 확대 출력이 structured 필터·신뢰 context·접속 URL을 변경하지 않는다.
11. 근거 없음/자료 범위 밖/사건 날짜 해석 필요가 각 status로 구분되며 활동 부재나 확정 날짜를 만들지 않는다.
12. 다른 model revision/dimension/chunking 공간은 혼합되지 않고 vector 길이 불일치는 거부된다. lexical 기준선은 임베딩 없이 실행 가능하다.
13. 원격 IP·LAN·Supabase Cloud·loopback 위장/redirect 연결을 guard가 거부하고 SQL 실행 0건을 증명한다. 허용 loopback도 프로젝트 전용 자원인지 별도로 검증한다.
14. 공개 결과/로그/fixture 및 합성 회귀 산출물에는 실제 이름·handle·원본 이미지·배포 ID·절대 비공개 경로가 없다. 승인된 비공개 연구 결과의 최소 근거 인용은 데이터 사용 정책을 따르며, credentials는 어떤 결과/로그에도 포함하지 않는다. 테스트는 합성 입력으로 재현된다.
