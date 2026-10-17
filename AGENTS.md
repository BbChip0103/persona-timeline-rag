# persona-timeline-rag — 작업 규칙

## 범위

- 최종 PoC는 연구용 AI 페르소나의 멀티턴 채팅과 대화 속 타임라인 근거 활용이다. 공개 빌드는 가상 포스트 초안을 지원하고 이미지 생성은 비활성화한다. 생성물은 실제 활동 근거로 재유입하지 않는다.
- 연구 DB는 전용 로컬 Supabase와 검증된 loopback 연결만 허용한다. 외부 모델 전송/비용/개인자격 조건은 실행 전 확인한다.

## 검증과 커밋

- 공개 저장소의 리모트는 공개 프로젝트에서 별도로 설정한다. 비공개 원본 저장소 정보는 공개 문서에 기록하지 않는다.
- **각 논리적인 작업 단위가 끝나면 검증하고 로컬 커밋을 남긴다.** 다음 작업으로 넘어가거나 완료를 보고하기 전에 해당 변경의 커밋 hash를 확인한다. 매 파일 저장마다 커밋하거나 미완료 상태를 완료로 포장하지 않는다.
- 목적이 다른 변경은 분리하고, 관련 파일만 명시적으로 stage한다. 사용자/다른 작업의 변경을 함께 커밋하지 않는다. 메시지는 변경 내용과 목적을 짧게 적는다.
- Python 변경은 `make check`; TS/API/UI를 만들면 해당 unit/typecheck/lint/build/E2E 등 변경 범위에 맞는 검증을 추가한다. 문서-only 변경은 링크/계약/공개경계 검사를 한다. 수행하지 못한 검증과 잔여 실패는 기록한다.
- 첫 TS 채팅 단계에 얇은 실행/평가 하네스를 함께 만든다. 기본은 외부호출 없는 fake/live-disabled이며 `retrieval=off`는 검색/embedding0회로 검증한다. live는 개인자격·자료전송·호출/token/image/credit 상한이 명시된 run에서만 실행한다.
- 실행별 code/persona/prompt/model/case revision과 private 결과/trace/비용·오류를 기록한다. fake/live·고정history/누적대화를 구분하고, image task 재개와 submit retry를 분리해 중복과금을 막는다. 같은 core/검증 규칙을 쓰며 runner에 정책을 따로 구현하지 않는다.
- `data/`, `reports/`, `*.private.md`, `.env` 등은 비공개로 유지한다. 공개 fixture/CI 출력은 합성 데이터만 쓴다.
- 에이전트는 `reports/review/**`(사람 검수 시트)와 S8 결과 파일의 행 내용을 읽거나 출력하지 않는다. 확인은 파일 존재·권한·행 수만 한다([사람 검수 표본](docs/review-sampling.md)).
- **push는 사용자의 명시적 요청이 있을 때만 한다.** remote 설정/로컬 commit과 GitHub 업로드는 구분한다. force push/amend/reset으로 공유 이력을 덮지 않는다.

## 논의·진행 이력

- 설계 결정과 논의 이력은 비공개 설계 노트에 보관한다. 이 저장소의 docs는 현재 계약과 재현 방법만 설명한다.
- 비공개 이슈 기록과 접속 정보·키·원본 데이터는 이 저장소에 복사하지 않는다.

## 범용 라이브러리 선택 원칙

- 범용 기능은 현업 채택과 검증된 범용성을 우선한다. 최신·유행·GitHub 별 수만으로 선택하지 않고 실제 사용 사례, 유지보수 상태, 문서·생태계, 보안 및 현재 스택과의 호환성을 근거로 판단한다.
- 이미 사용하는 프레임워크의 공식 표준 기능을 먼저 활용한다. 추가 의존성이 필요하면 널리 쓰이고 안정적으로 유지되는 선택지를 우선하며, 같은 역할의 라이브러리를 불필요하게 중복 도입하지 않는다.
- 인기만을 이유로 기존 계약을 바꾸거나 과도한 프레임워크를 도입하지 않는다. 덜 보편적인 선택이나 custom adapter가 필요하면 대중적 대안과의 비동등성·필요한 정책을 명시하고 회귀 테스트로 고정한다.

## LangChain-first 구현 원칙

- 범용 LLM/RAG 기능은 공식 LangChain/LangGraph 구성요소를 먼저 확인하고 사용한다. 이미 직접 구현했더라도 동등한 계약을 지원하면 네이티브 구현으로 이관하고 중복 흐름을 제거한다.
- 단순 Runnable 래퍼를 붙인 것을 알고리즘 이관이라고 보고하지 않는다. 실제 SDK가 담당하는 기능과 남는 custom adapter/정책을 구분한다([현재 경계](docs/langchain-components.md)).
- 인물/기간/라이선스/원문·이미지 provenance, 삭제/소유권/deadline, 비용·unknown receipt/재제출 금지, 엄격한 JSON/바이트 제한은 유지한다. 사용자가 요청하지 않은 기본 파서의 자동 보정·token split/extra batch/retry·고정top-N·두 번째 memory DB로 계약을 바꾸지 않는다.
- SDK raw-document 자동 tracing은 차단하고 기존 redacted application telemetry만 유지한다. 의존성 업그레이드 시 private async hook/클라이언트 bridge 및 데이터·과금 동등성을 회귀 검증한다.
