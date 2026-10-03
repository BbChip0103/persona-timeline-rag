# persona-timeline-rag — 작업 규칙

## 범위

- 최종 PoC는4명 연구용 AI 페르소나의 멀티턴 채팅과 대화 속 타임라인 근거 활용이다. 순서는 채팅환경→4명채팅/가상포스트·External image 이미지표현 검증(RAG off)→timeline RAG/비교다. 생성물은 실제활동근거로 재유입하지 않는다. 현재상태/계약은README와docs를 따른다.
- 기존 Python ingestion은 유지하고 서비스는 reference agent loop 호환 계열로 독립 구현한다. 다른 프로젝트 소스/seed/prompt/credentials/운영·staging·공유DB를 사용하거나 변경하지 않는다.
- 연구 DB는 전용 로컬 Supabase와 검증된 loopback 연결만 허용한다. 외부 모델 전송/비용/개인자격 조건은 실행 전 확인한다.

## 검증과 커밋

- 사용자의 지정 리모트: `private source repository` (`origin`). 변경이 필요하면 요청/근거 없이 다른 저장소로 바꾸지 않는다.
- **각 논리적인 작업 단위가 끝나면 검증하고 로컬 커밋을 남긴다.** 다음 작업으로 넘어가거나 완료를 보고하기 전에 해당 변경의 커밋 hash를 확인한다. 매 파일 저장마다 커밋하거나 미완료 상태를 완료로 포장하지 않는다.
- 목적이 다른 변경은 분리하고, 관련 파일만 명시적으로 stage한다. 사용자/다른 작업의 변경을 함께 커밋하지 않는다. 메시지는 변경 내용과 목적을 짧게 적는다.
- Python 변경은 `make check`; TS/API/UI를 만들면 해당 unit/typecheck/lint/build/E2E 등 변경 범위에 맞는 검증을 추가한다. 문서-only 변경은 링크/계약/공개경계 검사를 한다. 수행하지 못한 검증과 잔여 실패는 기록한다.
- 첫 TS 채팅 단계에 얇은 실행/평가 하네스를 함께 만든다. 기본은 외부호출 없는 fake/live-disabled이며 `retrieval=off`는 검색/embedding0회로 검증한다. live는 개인자격·자료전송·호출/token/image/credit 상한이 명시된 run에서만 실행한다.
- 실행별 code/persona/prompt/model/case revision과 private 결과/trace/비용·오류를 기록한다. fake/live·고정history/누적대화를 구분하고, image task 재개와 submit retry를 분리해 중복과금을 막는다. 같은 core/검증 규칙을 쓰며 runner에 정책을 따로 구현하지 않는다.
- 커밋 전에 `git diff --cached --check`와 staged 파일/내용을 검토한다. 원본 데이터/캡션/이미지·실제persona/대화·보고서·승인/배포정보·키·다른 프로젝트 자료가 들어가지 않아야 한다. `.gitignore`는 secret 검사나 접근통제를 대신하지 않는다.
- `data/`, `reports/`, `*.private.md`, `.env` 등은 비공개로 유지한다. 공개 fixture/CI 출력은 합성 데이터만 쓴다.
- **push는 사용자의 명시적 요청이 있을 때만 한다.** remote 설정/로컬 commit과 GitHub 업로드는 구분한다. force push/amend/reset으로 공유 이력을 덮지 않는다.

## 논의·진행 이력

- 기술 선택/대안/정정/검증/대화 히스토리는 별도 `private design notes` 레포의 `<private-design-notes>/`에 남긴다.
- `private design notes`는 결정/검증, `private design notes`는 원문과 논의, `private design notes`는 구현 상세 계획이다. 이 코드 레포의 docs는 현재 계약/재현 방법만 설명하며 과정 일지를 중복하지 않는다.
- 이슈 파일은 이 코드 레포의 커밋에 복사하지 않는다. 별도 레포의 수정과 커밋은 범위를 확인해 분리한다. 접속 정보/키/원본 데이터는 이슈에도 기록하지 않는다.
