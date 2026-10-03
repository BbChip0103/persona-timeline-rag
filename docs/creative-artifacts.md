# 페르소나 포스트 초안·이미지 생성 계약

상태: post draft와 별도 free-only image runner가 구현돼 있다. 실제 완료 파일/잔액 검증은 private run 보고서로 확인한다. API의 draft 버튼은 이미지 runner를 호출하지 않으며 창작물은 근거 코퍼스로 들어가지 않는다. [PRD](prd.md)의2단계에서 RAG를 끈 상태의 표현 기준선을 만들며, 최종 사실 조회는3단계에서 검증한다.

## 1. 창작물과 사실의 분리

- `chat`은 일반 대화, `post_draft`는 Instagram 형식 캡션/해시태그 초안, `image_draft`는 연계 이미지 생성이다. 실제 Instagram 계정에 로그인하거나 게시하지 않는다.
- 생성 캡션/이미지는 **AI 가상 초안**이다. 사용자가 지정한 가상 brief와 persona 표현을 반영할 수 있지만, 실제 활동/촬영/협찬/기억이었다고 표시하지 않는다.
- 예: “가상의 여행 콘텐츠를 써줘”는 창작 brief다. “특정 날짜에 실제 어디에 있었어?”는 사실 질문이므로 근거 없으면 미답이다. 창작 brief를 사실 질문의 대체 답으로 주지 않는다.
- 생성 이미지·캡션·대화는 canonical SourcePost/Event/Gold에 넣지 않는다. 생성물을 미래 검색의 실제 기억으로 재유입하지 않는다.
- 이 문서의 image generation은 **새 이미지 창작**이다. 원본 JPEG를 VLM으로 읽어 RAG 근거를 보강하는 `caption_image_rag`와 별개다. 후자는3단계 이후 선택 확장이다.

## 2. `CreativeArtifact` 제안 기록

`artifact_id`, `person_id`, `persona_revision`, `session_id`(선택), `brief_id`, `kind: post_draft | image_draft`, `origin: generated`, `fictional: true`, `status`, `content_ref`, `prompt_revision`, `provider`, `model`, `quality`, `resolution`, `aspect_ratio`, `task_id`, `parent_artifact_id`, `reference_provenance`, `created_at`를 기록한다.

- 문자열/이미지 bytes와 실제 인물 mapping은 `data/generated/`, run/평가/비용은 `reports/creative/` 아래 비공개로 둔다. 공개 fixture는 합성 인물/합성 이미지 metadata다.
- persona·brief·prompt/model/settings/hash를 보존하여 같은 조건의 재평가를 가능하게 한다. profile 사실 refs와 창작 brief refs는 구분한다.
- 화면에는 AI/가상 초안 표시와 실패/대기/완료를 표시한다. 내부prompt/API key/절대 private 경로/서명URL을 공개하지 않는다.

## 3. 공개 API 설계와 현재 free-only 웹 transport 구분


아래 공개 Bearer API는 별도 설계이고 현재 free runner에 섞지 않는다. 선택은 **External image GPT Image 2, quality medium**이다. 프로젝트 내부 model alias를 `gpt-image-2`로 쓰더라도 **공식API 전송값은 `model: "GPT Image 2"`**로 명시한다. quality, model, resolution, aspect ratio는 별도 필드다.

공식 [이미지 API 사용 문서](https://docs.external-image.ai/reference/text-to-image-image-edit-task-api-usage), [submit](https://docs.external-image.ai/reference/text_to_image_submit_task), [query](https://docs.external-image.ai/reference/text_to_image_query_task), [upload](https://docs.external-image.ai/reference/upload-api-usage)에 근거한 구현 계획:

1. 프로젝트 전용 개인 API key/user ID를 서버 쪽에서만 읽는다. 요청은 `Authorization: Bearer <apiKey>`와 `External image-Uid`를 사용한다. 연구에 명시 허용되지 않은 다른 프로젝트 cookie/key/user ID를 사용하지 않는다. 현재 사용자의 cookie 예외는 free 웹 runner에만 적용한다.
2. 텍스트 생성은 `POST /v1/common_task/text2image/task/submit`, 편집은 `/v1/common_task/image_edit/task/submit`. 반환 taskId를 저장하고 해당 `/task/query`로 상태를 확인한다.
3. 상태 `init/running/success/fail`과 **이미지별 subtask status/error**를 검사한다. HTTP200/submit 성공/parent success만으로 파일 생성을 완료 처리하지 않는다.
6. 완성 결과의 per-image fileId/filePath/크기·실제 bytes를 확인하고 private 파일로 저장한다. 공급자 download URL의 만료/다운로드 host는 실제 응답 계약을 확인한 allowlist로 다룬다. 모델이 제시한 임의 URL/local 경로를 fetch하지 않는다.

첫 설정은 `quality=medium`, `resolution=1K`, `aspectRatio=4:5`, `generateCount=1`을 제안한다.4:5는 포스트 초안 설정이지 모델 제약이 아니다.16references/최대4장 batch는 초기 테스트에 필요하지 않다. API 스키마와 서비스 접근은 실행 직전 다시 확인한다.

## 4. 과금·재시도·취소

공식 문서의 medium 가격은1K/2K/4K 각각0.20/0.80/1.40 credits per image다. 이는 문서의 API credit표이며 USD 요금/개인 계정 실제 quota·과금 결과가 아니다. 호출 전 개인 자격/데이터 전송 조건/총 credit 한도를 확정한다. 최초검증은 인물별1장(총4장) 계획이며 자동 확장하지 않는다.

- 문서는 submit에서 credits를 예약/차감하고 실제 성공 소비 정산/실패 환불을 설명한다. run 결과 `costCredit`와 실제 이미지별 성공/실패를 기록한다. 다른 프로젝트 wrapper의 Replicate USD값이나 unlimited무료 설명을 적용하지 않는다.
- poll은 문서 권고3~5초/timeout 약5분을 기본 후보로 삼는다. 제한/timeout은 정책으로 명시하고 provider상태/오류를 그대로 분리한다.
- submit 결과가 불명확하면 **자동 재제출하지 않는다**. API idempotency/중복과금 방지가 확인되지 않았다. taskId를 얻었으면 재시작 시 poll/download만 재개한다. query의 제한적 retry와 과금가능한 submit retry를 분리한다.
- 서버/사용자 취소는 local 결과 채택을 중단하지만 공급자 과금/실행 취소 성공을 의미하지 않는다. 공개 API cancel/idempotency 계약은 미확인이다. 늦게 도착한 결과는 기존job에만 연결하고 세션 최신답변을 덮지 않는다.

## 5. 참고와 독립 구현 경계

other-project `image CLI`는 prompt→submit→poll→download, task 저장/재개와 provider 분리를 참고한다. 다른 프로젝트 source/preset/persona/ref 이미지/자격 파일을 복사하거나 해당 command를 개인 결과 생성에 실행하지 않는다. 내부 파일/라인과 공개 API 차이는 private 호환 명세에 남긴다.

기본은 text-only synthetic brief/독립 작성 persona 지시다. 실제 인물 사진·원본 캡션/자료를 External image에 전송하는 것은 별도 이용조건/전송 허용을 확인한 뒤다. 데이터셋 사용승인이나 이미지모델 선택 자체가 모든 원본의 외부업로드 허가는 아니다.

## 6. 기준선 평가와 완료 gate

각 인물에3개 post brief(총12개)와 인물별1개 image brief(총4개)로 시작할 계획이다. 둘은 RAG 평가의12대화/50질문과 별도 자산이다.

- 채팅: persona 언어/말투/분야/문맥, AI 표시, 실제활동 미상 시 미답.
- post: voice/주제/brief 준수·플랫폼형식·가상 표시. 실제person의 미확인 제품 사용·협찬·감정·사적 관계를 창작 fact로 포장하지 않음.
- image: brief/구도/표현·persona concept 일관성, 오류/비용/latency. 텍스트만으로 실제 얼굴 동일성이나 실제 촬영 사진을 재현했다고 판정하지 않음. reference 기반 likeness 검증은 허용자료가 있는 별도항목.
- 같은 persona/model/settings/brief의 기준선 revision을 고정한 후 RAG를 추가한다. 이미지의 미적 개선을 RAG 사실성 개선으로 합산하지 않는다.
- fake provider 계약검사와 실제External image 이미지4개 완료/다운로드/과금확인을 나눠 보고한다. credentials/권한 미정이면 실제실행은 미수행으로 남긴다.

합성 회귀: auth key 미노출, model/quality 혼동 거부, submit의중복retry방지, task재개, parent성공+child실패,timeout/cancel/late결과,허용되지않은ref 업로드 차단,generated→SourcePost 승격거부.
