# persona-timeline-rag

승인받은 Instagram 자료를 바탕으로 **인플루언서 AI 페르소나와 채팅하면서 과거 활동 타임라인 근거를 활용하는** 독립 개인 연구 프로젝트입니다. 채팅 환경 →4명 페르소나 채팅·가상포스트/이미지 표현 검증(RAG off) →timeline RAG 구축/비교 순서가 PoC 목표입니다. 실제 본인/공식 계정이 아닌 연구용 AI 시뮬레이션으로 표시합니다.

## 현재 구현 범위

Python 3.11+ 표준 라이브러리 기반의 데이터 준비 scaffold입니다.

후속 검색·답변 서비스는 향후 통합을 고려해 TypeScript/Node.js 기반으로 독립 구현할 계획입니다. 현재 Python 데이터 준비 코드는 유지하며, 서비스·DB·화면 스택의 채택 계획과 실제 구현 상태를 구분합니다. 다른 프로젝트 구현이나 데이터를 이 개인 저장소에 복사하지 않습니다.

이 저장소는 구현·데이터·현재 명세·재현 방법을 관리합니다. 기술 선택과 범위 변경 등 과정 히스토리는 저장소 밖의 작업 이슈 문서 옆에서 별도로 관리합니다.

- 제공자의 계정 명부와 게시물–이미지 매핑 읽기
- Google Drive 분할 ZIP 중앙 디렉터리 검색과 선택 계정 파일 추출
- HTTP Range, 크기·CRC, 메타데이터 소유자 검증 및 재실행 지원
- 캡션·게시 시각·출처·이미지 경로를 제한된 게시물 스키마로 정규화
- 다운로드·정규화 결과를 로컬 보고서에 기록

**아직 미구현:** VLM/OCR/ASR, 사건 추출·병합, 임베딩·벡터 DB, 검색 도구, 웹 검색 에이전트,4명 페르소나 정의·검수, 세션/멀티턴 채팅·API/UI 및 성능 평가. 유료 모델 호출이나 실시간 Instagram 스크래핑은 하지 않습니다. 다운로드 완료 여부는 실제 로컬 보고서로 확인하며, 계정당 게시물 수를 고정값으로 가정하지 않습니다.

배포 대상은 `.info` 메타데이터와 JPEG/캐러셀 이미지입니다. `is_video=true`인 게시물도 있을 수 있지만 영상 원본·오디오를 제공받거나 다운로드한 것은 아닙니다. 부분집합의 “전체”는 해당 snapshot에 제공된 선택 계정 파일을 뜻하며, 현재 Instagram 전체 기록이나 삭제 게시물 복원을 뜻하지 않습니다.

## 실행

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

선행 파일은 `data/manifests/candidates.json`, `archive_volumes.json` 및 `data/raw/instagram/`의 승인 자료입니다. 선택 계정은 최대 20명입니다. 배포 URL·Drive 파일 ID·실제 인물 후보·원본은 공개 예제에 포함하지 않습니다. `configs/research.example.json`은 연구 설정 예시이며 현재 CLI가 자동으로 읽는 설정 파일은 아닙니다. `.env.example` 역시 자동 로딩하지 않습니다.

현재 연구 타겟은 후보 중 4명입니다. 별도 `data/manifests/targets.json`과 `data/processed/target_posts.jsonl`에 실험 범위를 기록하며, 기존 20명 후보와 전체 정규화 코퍼스는 보존합니다. 데이터 준비 CLI는 기존 후보 manifest를 계속 사용하고, 연구 설정 예시는 4명 부분집합을 가리킵니다. 실제 대상과 수량은 비공개 `reports/targets4.md`에서 확인합니다.

## 구조

```text
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

구현 전 명세: [PRD](docs/prd.md) · [페르소나·채팅](docs/persona-chat.md) · [창작물](docs/creative-artifacts.md) · [근거 스키마](docs/evidence-schema.md) · [평가 명세](docs/evaluation.md). 실제 인물·수량·파일 연결은 Git에서 제외되는 `docs/dataset.private.md`에 기록합니다. 명세 작성은 검색·모델·DB 구현 완료나 성능 달성을 의미하지 않습니다.

## 라이선스와 한계

코드 라이선스와 데이터 사용 조건은 별개입니다. 현재 별도 코드 `LICENSE`는 지정하지 않았습니다. 향후 코드에 라이선스를 붙여도 승인 데이터·사진·캡션의 재배포 권한이 생기지 않습니다. 원본 제공자의 승인 조건과 원저작자의 권리를 따릅니다.

이 프로젝트는 과거 공개 활동에 대한 근거 검증 실험이며, 개인 추적·실시간 위치 추론·무근거 사생활 재구성을 목적으로 하지 않습니다. 원본의 과거 snapshot은 최신 활동 기록이 아닙니다.

## 최종 PoC 완료 단위

- 4명 각각 검수/버전 있는 persona와 AI 표시, 필수 최소 Next.js 채팅 화면.
- 인물에 고정된 세션에서 일반 대화→과거 활동→후속 질문→미답,5user turns 이상과 재접속/근거 카드.
- 검색 tool의 근거가 최종 페르소나 발화에 쓰이고 말투 변환으로 사실/날짜를 만들지 않음. 인물·세션 격리.
- 50게시물 추출 검수·50질문 평가와 별도12개 멀티턴 시나리오에서 같은 persona/model의 RAG on/off 비교.

DB/API/페르소나/모델/UI는 아직 미구현입니다. RAG off에서 채팅/가상포스트 초안과 External image GPT Image2 medium 이미지 표현을 먼저 검증합니다. 생성물은 실제게시물/활동근거가 아닙니다. 원본사진의 VLM/RAG 보강은 별도 선택확장이며 실제Instagram 게시/검색CLI만으로완료는 하지 않습니다.
