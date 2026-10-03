# Architecture

## 데이터 준비(구현됨)

```text
승인 배포 자료 + 로컬 계정 선택 manifest
  → 계정 명부 검증
  → 분할 ZIP 중앙 디렉터리에서 선택 계정 파일 검색
  → HTTP Range로 필요한 멤버 파일 추출
  → 크기·CRC / 메타데이터 owner / JPEG 시그니처 확인
  → 제공자의 게시물–carousel 이미지 매핑 적용
  → allowlist 게시물 스키마 정규화
  → 비공개 posts.jsonl + 로컬 감사 보고서
```

런타임 외부 라이브러리 의존성은 없습니다. 테스트는 합성 데이터로 구성합니다. 서버가 Range를 무시하거나 접근·할당량 오류 페이지를 돌려주면 전체 아카이브를 묵시적으로 다운로드하지 않고 실패합니다. 재실행이 가능하나 성공·누락·오류는 보고서와 계정별 실제 파일 수로 확인해야 합니다.

| 모듈 | 책임 |
|---|---|
| `datasets/catalog.py` | 제공자의 명부와 수집 시점 프로필 지표 읽기 |
| `datasets/drive.py` | bounded 다운로드, Drive 경고 폼, Range 검증·cache |
| `datasets/range_zip.py` | 분할 ZIP 디렉터리·멤버 읽기와 무결성 검증 |
| `datasets/subset.py` | 선택 계정 index, 부분집합 추출, 로컬 보고서 |
| `datasets/mapping.py` | 제공자의 정확한 게시물–이미지 관계 읽기 |
| `ingestion/instagram.py` | 현재 선택 계정의 게시물 정규화와 제외 기록 |
| `audit.py` | 실제 파일 CRC·정규화·제공자 매핑을 교차 확인하고 원본 누락과 로컬 실패 분리 |
| `schemas.py` | 원본 게시물 스키마; 사건 추출 결과가 아님 |
| `cli.py` | 위 단계의 명시적 로컬 실행 |

프로필 명부의 게시물 수는 전체 계정 snapshot 지표이지 다운로드 부분집합의 크기가 아닙니다. 한 게시물에 여러 이미지가 있을 수 있으므로 게시물 수와 이미지 수를 분리합니다. 영상 게시물의 JPEG를 받았더라도 원본 영상·음성을 확보했다고 간주하지 않습니다.

### 날짜와 근거

- `posted_at`: 원본 `taken_at_timestamp`를 UTC로 정규화한 **게시 시각**.
- `event_date`: 현재 미확정이며 기본값은 `null`.
- `event_date_basis`: 현재 기본값은 `unknown`.
- `source_file`, `source_url`, `image_files`: 원본 추적용 근거. 게시 URL의 현재 접근 가능성을 보장하지 않습니다.

이미지 경로 존재 확인과 JPEG 시그니처 검사는 전체 이미지 디코딩·인물 동일성 검증을 대체하지 않습니다. 사진 속 대상이 계정 소유자라는 추론도 자동으로 하지 않습니다.

## 인플루언서 AI 채팅과 타임라인 근거(구현됨)

아래 서비스 경계는 구현돼 있다. 실제 사람 검수/사건 정확도와 배포 성능은 아직 별도 검증이다. [runbook](runbook.md)이 현재 실행 계약이다. 최종 PoC는 인물별 페르소나로 일반 대화·과거 활동·후속 질문을 나누고, 실제 답변에 근거를 쓰는 채팅이다. 검색/CLI 질의는 중간 게이트다.

```text
기존 Python ingestion → immutable source posts/media → 전용 local Supabase
독립 persona 작성/검수 → versioned PersonaDefinition → person에 묶인 ChatSession
Next.js 채팅 → NestJS turn API → trusted session context
  → persona/history + intent/reference
  → 필요시 scoped search_timeline → evidence/시간 한계
  → provider 생성 → claim/근거 검증 → final reply + source cards
```

| 경계 | 책임 |
|---|---|
| identity/registry | 고정 person_id, 플랫폼 계정/alias, 승인/권한 |
| persona | 공개 프로필과 비공개 표현/행동/예시/AI 표시, 검수·버전·field provenance |
| timeline core | 원본·사건·관찰·임베딩, 인물/기간 검색과4상태, 게시일≠사건일 |
| conversation core | owner/person/revision 고정, 메시지·후속 reference·turn idempotency·tool trace |
| model/provider | intent/답변 생성 경계. 권한/DB/현실 이력 결정자 아님 |
| creative/provider | 가상포스트/이미지 job·External image·생성물 origin·비용. 원본사건과분리 |
| API/UI | 검증된 코어 호출, 인물 선택·채팅·근거 카드·재접속 |
| evaluation | 추출50게시물/질문50개/대화12개, 사실·표현·미답·비용 분리 |

서비스/코어는 TypeScript/Node.js·pnpm, API는 NestJS, 필수 최소 화면은 Next.js/React다. 전용 로컬 Supabase/PostgreSQL·pgvector와 SQL migrations를 사용하고 Python ingestion은 유지한다. 모델은 provider/worker 경계로 분리하며 필요한 경우 GPU worker만 Python을 고려한다.


DB는 전용 project_id·포트·Docker 자원·credentials 및 loopback guard로 격리한다. 다른 프로젝트 stage/prod/공유 DB나 Cloud 연결/remote migration은 하지 않는다. 현재 전용 DB-only local Supabase와 연결 guard/limited app role가 구현돼 있다. Auth/Storage/Studio 전체 스택은 아니다.

### 구현 게이트 — 세 단계

1. **채팅 환경:** TS/contracts·NestJS/Next.js·전용 local DB의세션/메시지·provider로 합성캐릭터 일반대화/reload/owner와person격리를 검증한다. source corpus/검색/embedding은 아직 요구하지 않는다.
2. **persona 표현 기준선:**4명 검수/버전persona의 실제대화와Instagram 가상포스트초안·External image GPT Image2 medium 이미지생성을 RAG off로 검증한다. 생성물은별도CreativeArtifact/job/provider이며실제SourcePost/Event로유입시키지않는다. 실제provider조건은호출전확정한다.
3. **RAG:**1,189건source import→lexical→semantic과사건추출표본/질문/대화평가. 같은persona/model/prefix의 off/lexical/semantic과각자누적history를구분해비교한다. 원본사진VLM 근거보강은그뒤선택이다.

[PRD](prd.md) · [페르소나·채팅](persona-chat.md) · [창작물](creative-artifacts.md) · [근거 계약](evidence-schema.md) · [평가](evaluation.md). 실제 대상/다른 프로젝트참고경로는비공개명세에 둔다.
