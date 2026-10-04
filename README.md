# persona-timeline-rag

승인받은 Instagram 자료를 바탕으로 **인플루언서 AI 페르소나와 채팅하면서 과거 활동 타임라인 근거를 활용하는** 독립 개인 연구 프로젝트입니다. 목표1은 4명 페르소나 채팅에 RAG를 연결하고 평가·관측하는 것, 이후 목표2는 LLM 서빙 구조·부하·복구 실험입니다. 실제 본인/공식 계정이 아닌 연구용 AI 시뮬레이션으로 표시합니다.

## 현재 구현 범위

- Python 승인 데이터 준비·검증 CLI 유지.
- TypeScript/pnpm workspace: NestJS API, Next.js/React 채팅, shared contracts/core/providers/storage.
- 전용 **DB-only 로컬 Supabase PostgreSQL15 + pgvector**: Auth/Storage/Studio 전체 배포가 아니다. owner/person/revision 고정 세션, history/reload, idempotency/cancel, lexical substring baseline 및1536dim exact cosine 검색.
- fake-by-default provider와 총 **US$1 durable shared ledger**, 알려진 응답 cache·불명확 제출 재전송 금지, private traces/보고서.
- 공개 fixture는 합성이다. 실제 persona는 개발 캡션 통계 기반 **silver**이며 사람 검수 완료/본인 복제 정확도를 주장하지 않는다. 근거 없는 사건 날짜를 게시일로 대체하지 않는다.
- 새 API 세션은 **agent-loop 캐릭터 에이전트**다. 페르소나·실제 누적 대화·최소 대화 변수와 근거를 받아 자연어 답변을 만들고, 선택적 읽기 전용 검색 도구를 제한된 루프로 실행한다. 과거 legacy 원문 인용 renderer와 구분하며 다른 프로젝트 reference agent loop 전체 엔진의 동등성을 주장하지 않는다.
- **RAG 없음 / 본문만 / 본문+이미지 설명**을 세션에 고정한다. 이미지 설명은 `gpt-6-luna`/`medium`으로 생성한 관찰·강조·의도 해석을 별도 출처로 색인하며, 원사진을 매 채팅 요청에 직접 넣는 방식은 아니다. 의도 해석은 단정형 어미여도 실제 작성자의 확정 의도가 아니다.
- 최근 사용자 대화를 활용한 검색과 직전 답변의 원근거 재사용은 별도 rewrite LLM 호출 없이 처리한다. 인용 검증은 출처·범위·문자열 결합을 확인하지만, 자연어 답변의 모든 주장을 의미적으로 검증하지는 않는다.

**[목표1 구현·결과 요약](docs/goal1-summary.md)**에서 최신 한국어 3조건 비교, 합성 대화 예시, 관측·비용과 잔여 한계를 확인한다. 실제 모델/이미지/평가 자료는 ignored `reports/`에만 둔다. 결과는 AI-assisted silver 개발 회귀이며 사람 gold·실인물 개성 복제·새 질문 일반화 성능을 입증하지 않는다. 전체 재테스트는 현재 보류하며 수정한 동작만 표적 검증한다. 독립 OCR/ASR, 사람 검수된 사건 추출/병합, 웹검색 및 목표2 서빙·부하 실험은 완료 항목이 아니다. 다른 프로젝트 코드·DB·운영 설정은 변경하지 않는다.

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
- 현재 캐릭터 채팅 비교는 같은 agent-loop 구조·모델에서 RAG 없음/본문/본문+이미지 설명의3조건을 사용합니다. lexical/semantic은 검색 알고리즘이며 이3조건과 별개입니다. 웹 검색은 미구현 선택 실험이고 로컬 RAG가 더 낫다는 결론을 미리 가정하지 않습니다.
- 반응·유머·분위기·가벼운 살붙이기는 캐릭터 대화의 일부입니다. 확인된 핵심 사건/주체의 모순, 사용자 정정 무시, 허위 원문 인용과 구분합니다. 기존 엄격한 사실성 진단 점수는 캐릭터 대화 전체의 성공 점수가 아닙니다.
- 미성년자는 대상에서 제외하고 댓글·사용자 태그 구조는 정규화하지 않습니다. 사진·캡션에 등장하는 제3자를 자동 익명화하는 기능은 아직 없으므로 별도 검수가 필요합니다.
- 승인 원본과 인물별 결과는 비공개입니다. 공개 저장소는 코드·문서·합성 테스트를 대상으로 합니다.

[로컬 재현](docs/local-setup.md) · [아키텍처](docs/architecture.md) · [데이터 정책](docs/data-policy.md) · [원본 데이터셋 소개](https://sites.google.com/site/sbkimcv/dataset/instagram-influencer-dataset)

설계/계약: [PRD](docs/prd.md) · [페르소나·채팅](docs/persona-chat.md) · [창작물](docs/creative-artifacts.md) · [근거 스키마](docs/evidence-schema.md) · [평가 명세](docs/evaluation.md). 실제 인물·수량·파일 연결은 Git에서 제외되는 `docs/dataset.private.md`에 기록합니다. 명세 작성은 검색·모델·DB 구현 완료나 성능 달성을 의미하지 않습니다.

## 라이선스와 한계

코드 라이선스와 데이터 사용 조건은 별개입니다. 현재 별도 코드 `LICENSE`는 지정하지 않았습니다. 향후 코드에 라이선스를 붙여도 승인 데이터·사진·캡션의 재배포 권한이 생기지 않습니다. 원본 제공자의 승인 조건과 원저작자의 권리를 따릅니다.

이 프로젝트는 과거 공개 활동에 대한 근거 검증 실험이며, 개인 추적·실시간 위치 추론·무근거 사생활 재구성을 목적으로 하지 않습니다. 원본의 과거 snapshot은 최신 활동 기록이 아닙니다.

## 완료 범위와 남은 gate

로컬 DB/API/UI, 버전 페르소나, 원본문·이미지 설명 RAG, 멀티턴 맥락 연결과3조건 실행·기록은 구현/실행됐습니다. 가상 포스트·이미지 표현도 기준선 검증을 했으며 생성물은 실제 게시물/활동 근거로 재유입하지 않습니다.

**실행 완료와 품질 목표 달성은 다릅니다.** 기술 오류의 표적 보완과 인물별 페르소나 차별화는 목표1 마감 작업이며, 사람 의미 검수·고유 말투 충실도·정정 후 다른 기억으로 복구·새 질문 일반화는 별도 잔여 gate입니다. 최초 검수/평가 목표 수량을 충족했다고 소급 주장하지 않습니다. 최신 측정 결과와 이후 미평가 변경은 [요약](docs/goal1-summary.md)에서 구분합니다. 목표2·Kubernetes·다른 프로젝트 병합/배포·추가 과금 실험으로 자동 확대하지 않습니다.
