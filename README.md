# persona-timeline-rag

승인받은 Instagram 자료를 바탕으로 **인플루언서 AI 페르소나와 채팅하면서 과거 활동 타임라인 근거를 활용하는** 독립 개인 연구 프로젝트입니다. 채팅 환경 →4명 페르소나 채팅·가상포스트/이미지 표현 검증(RAG off) →timeline RAG 구축/비교 순서가 PoC 목표입니다. 실제 본인/공식 계정이 아닌 연구용 AI 시뮬레이션으로 표시합니다.

## 현재 구현 범위

- Python 승인 데이터 준비·검증 CLI 유지.
- TypeScript/pnpm workspace: NestJS API, Next.js/React 채팅, shared contracts/core/providers/storage.
- 전용 **DB-only 로컬 Supabase PostgreSQL15 + pgvector**: Auth/Storage/Studio 전체 배포가 아니다. owner/person/revision 고정 세션, history/reload, idempotency/cancel, lexical substring baseline 및1536dim exact cosine 검색.
- fake-by-default provider와 총 **US$1 durable shared ledger**, 알려진 응답 cache·불명확 제출 재전송 금지, private traces/보고서.
- 공개 fixture는 합성이다. 실제 persona는 개발 캡션 통계 기반 **silver**이며 사람 검수 완료/본인 복제 정확도를 주장하지 않는다. 근거 없는 사건 날짜를 게시일로 대체하지 않는다.
- Timeline 답변은 모델의 자유 사실 문장이 아닌 **검증된 원문 인용 renderer**다. 인용 일치가 의미적 entailment나 실제 사건 검증을 보장하지 않는다.

실제 모델/이미지/평가 실행 결과는 ignored `reports/`에서 확인한다. 구현/합성 테스트 통과와 실제 실행·사람검수 품질을 구분한다. VLM/OCR/ASR, 독립 검수된 사건 추출/병합, 웹검색 및 Goal2 LLM serving/부하 실험은 이번 구현의 완료 항목이 아니다. 다른 프로젝트 코드·DB·운영 설정은 변경하지 않는다.

## 실행

채팅/DB/live 재현은 [서비스 runbook](docs/runbook.md)을 따른다. 기본 합성 검증은 `pnpm install && pnpm check`, 웹 빌드는 `pnpm build:web`다. 실제 자료 없이 합성 테스트를 실행할 수 있다.


```bash
# 승인 데이터 없이 실행 가능한 합성 fixture 테스트
make test

# 별도 설치 없이 CLI 확인
PYTHONPATH=src python -m persona_timeline_rag --help

# 아래 명령은 승인 자료와 로컬 manifest 준비 후 실행
PYTHONPATH=src python -m persona_timeline_rag catalog
PYTHONPATH=src python -m persona_timeline_rag index --kind metadata
PYTHONPATH=src python -m persona_timeline_rag download-subset --kind metadata
PYTHONPATH=src python -m persona_timeline_rag index --kind images
PYTHONPATH=src python -m persona_timeline_rag download-subset --kind images
PYTHONPATH=src python -m persona_timeline_rag map-images
PYTHONPATH=src python -m persona_timeline_rag normalize
PYTHONPATH=src python -m persona_timeline_rag audit
```

선행 파일은 `data/manifests/candidates.json`, `archive_volumes.json` 및 `data/raw/instagram/`의 승인 자료입니다. 선택 계정은 최대 20명입니다. 배포 URL·Drive 파일 ID·실제 인물 후보·원본은 공개 예제에 포함하지 않습니다. `configs/research.example.json`은 연구 설정 예시이며 현재 CLI가 자동으로 읽는 설정 파일은 아닙니다. 서비스는 명시적으로 `node --env-file=.env.local --import tsx ...`로 설정을 로딩합니다. ingestion CLI는 자동 로딩하지 않습니다.

현재 연구 타겟은 후보 중 4명입니다. 별도 `data/manifests/targets.json`과 `data/processed/target_posts.jsonl`에 실험 범위를 기록하며, 기존 20명 후보와 전체 정규화 코퍼스는 보존합니다. 데이터 준비 CLI는 기존 후보 manifest를 계속 사용하고, 연구 설정 예시는 4명 부분집합을 가리킵니다. 실제 대상과 수량은 비공개 `reports/targets4.md`에서 확인합니다.

## 구조

```text
apps/api/       # NestJS local API
apps/web/       # Next.js local chat + authenticated BFF
packages/       # shared contracts/core/storage/providers/images
supabase/       # immutable SQL migrations
infra/          # isolated DB-only compose/bootstrap
scripts/        # preparation/live/evaluation/effort harness
e2e/            # synthetic browser boundary tests
src/persona_timeline_rag/
  datasets/     # 명부·Drive·분할 ZIP·부분집합·이미지 매핑
  ingestion/    # 원본 메타데이터 → 제한된 게시물 스키마
  schemas.py    # 게시일과 사건일을 분리하는 데이터 모델
  cli.py        # 로컬 데이터 준비 명령
tests/          # 원본 데이터가 아닌 합성 fixture
configs/        # 공개 가능한 설정 예시
docs/           # 설계와 데이터 정책
data/           # 원본·cache·manifest·정규화 결과: Git 제외
reports/        # 실제 계정·다운로드·평가 보고서: Git 제외
```

## 연구 원칙

- **게시일 ≠ 사건일.** 원본 게시 시각은 `posted_at`; 근거가 없으면 `event_date`는 비워 둡니다.
- 같은 페르소나/모델의 무검색·lexical·semantic 대화 baseline을 비교하고 웹 검색은 선택 실험으로 두며, 로컬 RAG가 더 낫다는 결론을 미리 가정하지 않습니다.
- 미성년자는 대상에서 제외하고 댓글·사용자 태그 구조는 정규화하지 않습니다. 사진·캡션에 등장하는 제3자를 자동 익명화하는 기능은 아직 없으므로 별도 검수가 필요합니다.
- 승인 원본과 인물별 결과는 비공개입니다. 공개 저장소는 코드·문서·합성 테스트를 대상으로 합니다.

[로컬 재현](docs/local-setup.md) · [아키텍처](docs/architecture.md) · [데이터 정책](docs/data-policy.md) · [원본 데이터셋 소개](https://sites.google.com/site/sbkimcv/dataset/instagram-influencer-dataset)

설계/계약: [PRD](docs/prd.md) · [페르소나·채팅](docs/persona-chat.md) · [창작물](docs/creative-artifacts.md) · [근거 스키마](docs/evidence-schema.md) · [평가 명세](docs/evaluation.md). 실제 인물·수량·파일 연결은 Git에서 제외되는 `docs/dataset.private.md`에 기록합니다. 명세 작성은 검색·모델·DB 구현 완료나 성능 달성을 의미하지 않습니다.

## 라이선스와 한계

코드 라이선스와 데이터 사용 조건은 별개입니다. 현재 별도 코드 `LICENSE`는 지정하지 않았습니다. 향후 코드에 라이선스를 붙여도 승인 데이터·사진·캡션의 재배포 권한이 생기지 않습니다. 원본 제공자의 승인 조건과 원저작자의 권리를 따릅니다.

이 프로젝트는 과거 공개 활동에 대한 근거 검증 실험이며, 개인 추적·실시간 위치 추론·무근거 사생활 재구성을 목적으로 하지 않습니다. 원본의 과거 snapshot은 최신 활동 기록이 아닙니다.

## 최종 PoC 완료 단위

- 4명 각각 검수/버전 있는 persona와 AI 표시, 필수 최소 Next.js 채팅 화면.
- 인물에 고정된 세션에서 일반 대화→과거 활동→후속 질문→미답,5user turns 이상과 재접속/근거 카드.
- 검색 tool의 근거가 최종 페르소나 발화에 쓰이고 말투 변환으로 사실/날짜를 만들지 않음. 인물·세션 격리.
- 50게시물 추출 검수·50질문 평가와 별도12개 멀티턴 시나리오에서 같은 persona/model의 RAG on/off 비교.

DB/API/UI 및 버전 persona와 모델 경계는 구현됐습니다. 실제 품질은 private run과 후속 사람 검수로 확인합니다. RAG off에서 채팅/가상포스트 초안과 External image GPT Image2 medium 이미지 표현을 먼저 검증합니다. 생성물은 실제게시물/활동근거가 아닙니다. 원본사진의 VLM/RAG 보강은 별도 선택확장이며 실제Instagram 게시/검색CLI만으로완료는 하지 않습니다.
