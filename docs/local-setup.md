# 로컬 재현과 manifest

공개 저장소에는 승인 자료나 실제 계정 선택 파일이 없습니다. 합성 테스트는 데이터 없이 실행됩니다. 아래 단계는 제공자 승인을 얻은 사용자의 로컬 환경에서만 수행합니다.

1. `PYTHONPATH=src python -m persona_timeline_rag download-pilot --folder-id <approved-folder-id>`로 명부·동봉 README·샘플만 받습니다. ID를 공개 파일에 저장하지 않습니다.
2. 동봉 조건을 읽고 `data/manifests/candidates.json`을 준비합니다. 형식은 `{"people": [{"username": "synthetic_account", "cohort": "domestic", "display_name": "합성 예시", "evidence_url": "https://example.com/"}]}` 입니다. 실제 파일에는 명부에 있는 중복 없는 계정 1–20개를 사용합니다. 국내 분류는 국적이 아닙니다.
3. 제공자 배포 목록으로 `data/manifests/archive_volumes.json`을 만듭니다. `metadata`와 `images` 배열의 각 항목은 `{"name": "posts_info.z01", "id": "approved-file-id", "size_bytes": 123}` 형식입니다. 예시 ID/크기는 실행할 값이 아닙니다. **배열 순서는 `.z01`, `.z02`, …, 마지막 `.zip`** 이며 정확한 크기가 필요합니다. Drive 공개 페이지 목록은 일부만 표시될 수 있어 첫 페이지를 완전한 목록으로 취급하면 안 됩니다.
4. 승인된 `JSON-Image_files_mapping.txt`를 `data/raw/instagram/`에 보관합니다. `map-images`로 선택 계정의 정확한 carousel 관계를 추출합니다.
5. `index --kind metadata`, `index --kind images`로 원본 중앙 디렉터리를 끝까지 확인합니다. 이 단계도 네트워크와 수 GB의 private cache를 사용합니다.
6. `download-subset --kind metadata --workers 4` 및 `download-subset --kind images --workers 4`를 실행합니다. 동시 요청은 종류별 1–8개로 제한됩니다. 재실행은 기존 파일의 CRC를 확인하고 빠진 항목을 받습니다. 접근/할당량 제한을 우회하지 않습니다.
7. `normalize` 다음 `audit`를 실행해 실제 파일과 정규화 결과를 교차 확인합니다. 원본 매핑에만 있고 ZIP에 없는 항목은 원본 제공 부족이며 로컬 다운로드 오류와 구분합니다.

보고서·명단·배포 ID는 `data/`, `reports/`에만 보관합니다. Git 공개 전 `git status --short`, `git diff --cached --name-only`와 전체 이력을 확인합니다. 코드 라이선스와 데이터 승인 조건은 별개입니다.

배포 JPEG는 리사이즈된 이미지일 수 있습니다. VLM/OCR 품질 평가 전에 실제 해상도를 확인해야 하며, 원본 고해상도 사진을 확보했다고 가정하지 않습니다.
