# 내부 납품 산출물: 기본 템플릿과 테이블정의서

근거: 2026-11-05 재영 지시(기획 세션 header 전달). 산출물 9종(엑셀 5 · 워드 4) 가운데 이번에는 기본 템플릿과 3번 테이블정의서만 만든다.

## 정해진 것

- 위치는 `deliverables/` 다. 생성 스크립트·템플릿·`requirements.txt` 만 커밋한다. 결과 파일(`deliverables/out/`)과 venv(`deliverables/.venv/`)는 gitignore 한다.
- 템플릿: `deliverables/templates/template.xlsx` · `template.docx`. `build_templates.py` 가 만든다. 생성 스크립트는 템플릿을 열고 내용만 채운다.
  - 표지: 문서명 · 프로젝트명(WHALE ERP) · 문서 번호 · 버전 · 작성일 · 작성자(인터플러그)
  - 개정 이력: 버전 · 일자 · 변경 내용 · 작성자. 워드는 표지 다음 쪽, 엑셀은 「개정 이력」 시트
  - 머리글에 문서명, 바닥글에 쪽 번호. 워드 표지 쪽에는 머리글·바닥글을 두지 않는다
  - 워드 스타일: 제목 1~3 · 본문 · 표 스타일(`WHALE 표`)
  - 엑셀: 이름 있는 셀 스타일(`머리행` · `본문`)로 머리행 색 · 테두리를 두고, 스크립트가 틀 고정 · 자동 필터 · 열 너비를 붙인다
  - 글꼴: 맑은 고딕 하나
- 문서 번호는 `WHALE-<약어>-<버전>`. 테이블정의서는 `WHALE-TBL-1.0`.
- 작성자는 「인터플러그」다(표지 · 개정 이력, 2026-11-05 재영).
- 버전은 스크립트 인자(`--version`)로 받는다. 개정 이력의 줄은 `deliverables/revisions.json` 에 둔다. 인자 버전이 그 파일에 없으면 멈춘다(내용을 지어내지 않으려고).
- 테이블정의서(`build_table_definition.py`): 원본은 `prisma/schema.prisma` 하나.
  - 시트: 표지 · 개정 이력 · ERD(이미지) · 테이블 목록 · enum 목록 · 테이블마다 한 시트
  - enum 목록: enum(DB 타입명) · Prisma 이름 · 설명 · 값. 값에 `///` 가 있으면 「값 — 설명」으로 적는다. 컬럼 타입이 enum 이면 그 줄로 링크한다(2026-11-05 재영, header 대조).
  - 테이블 목록: 테이블명 · 설명 · 컬럼 수. 테이블명에서 그 시트로 링크
  - 테이블 시트: 컬럼 · 타입 · NULL · 기본값 · PK/FK/UNIQUE · 인덱스 · 설명
  - 설명은 `///` 주석을 그대로 옮긴다. 없으면 비운다. 1팀 테이블도 원문 그대로다.
  - 기본값은 Prisma 표기가 아니라 마이그레이션 SQL 의 DEFAULT 값으로 적는다: `now()` → `CURRENT_TIMESTAMP`, `[]` → `'{}'`, 문자열 → `'값'`(jsonb 면 `'{}'::jsonb`), 열거형 → `'값'`, `dbgenerated("…")` → 안의 SQL(`now()` 면 `CURRENT_TIMESTAMP`), `autoincrement()` → `IDENTITY` (#249 리뷰 후속, 2026-11-05)
  - 담당 팀 칸은 두지 않는다. 앞으로 만들 엑셀 산출물에도 두지 않는다(2026-11-05 재영).
  - ERD 는 Pillow 로 그린다(엑셀에 이미지를 넣는 데 어차피 필요). graphviz 같은 시스템 의존성은 들이지 않는다. 전체 테이블을 한 장에 그리고 Prisma 관계만 선으로 잇는다. 한글 글꼴을 못 찾으면 기본 글꼴로 넘어가지 않고 멈춘다(#249 리뷰 후속).
  - CHECK · SQL 에만 있는 외래키 · 부분 고유 인덱스처럼 SQL 에만 있는 제약은 schema.prisma 에 없어 담지 않는다. 테이블 목록 시트에 그 사실을 한 줄로 적는다.
  - 엑셀 시트 이름은 31자까지라 그보다 긴 테이블명은 잘라 쓴다.

## 실행

Python 은 3.12 로 고정한다(`deliverables/.python-version`). 3.15 에는 Pillow 11.3.0 휠이 없다(#249 리뷰 후속).

```bash
cd deliverables
uv venv -p 3.12 .venv && uv pip install -p .venv/bin/python -r requirements.txt
.venv/bin/python build_templates.py                       # 템플릿을 다시 만들 때만
.venv/bin/python build_table_definition.py --version 1.0  # → out/WHALE-TBL-1.0_테이블정의서.xlsx
.venv/bin/python test_build_table_definition.py           # 파서 자체 검사 + /// 블록 전수 대조
```

API 명세는 `2026-11-05-deliverables-api-spec.md`.

## 하지 않는 것

- 나머지 산출물 8종. 워드 채우기 함수도 워드 산출물을 만들 때 만든다.
- 열거형 값 목록 시트(요청에 없음).
