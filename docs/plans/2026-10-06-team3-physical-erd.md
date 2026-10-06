# 3팀 물리 ERD

- 작성: 2026-10-06 · claude-code/opus-5.5
- 요청: 기획 세션 전달, 재영 지시 (2026-10-06)
- 범위: 물리 ERD 문서와 화면까지. **Prisma 변환은 하지 않는다** — 재영이 화면을 확인한 뒤 따로 지시한다.

## 근거

| 무엇 | 어디 |
|---|---|
| 3팀 논리 ERD | front `docs/erd/README.md`(컬럼 카탈로그), `_build.py`(모델·배치), 영역별 html |
| 네이밍 규칙 | api `docs/raw/2026-09-30-네이밍-규칙.md`, `okf/conventions/naming.md` |
| 형식 견본 | front `docs/erd/team1/schema.sql`, `_build_physical.py`, 1팀 물리 ERD 화면 |
| 1팀 참조 | `bp_codes.bp_code_id`, `stores.store_id`, `admin_accounts.admin_account_id` — 정수 PK |

## 산출물

| 무엇 | 어디 | 비고 |
|---|---|---|
| 생성 스크립트 | api `docs/erd-physical/_build_physical.py` | front 카탈로그를 읽어 아래를 만든다 |
| 물리 테이블 정의서 | api `docs/raw/2026-10-06-3팀-물리-ERD.md` | okf-ingest 원자료 |
| DDL | api `docs/raw/2026-10-06-3팀-schema.sql` | PostgreSQL 15+, 1팀 schema.sql 과 같은 모양 |
| 화면 | front `docs/erd/physical/` 만 | 영역별 탭 html. 미니 `/erd/` 에서 보인다 |

front 에서는 `docs/erd/physical/` 밖을 건드리지 않는다.

## 정해진 것

- **주휴일 컬럼 유지.** 근로계약서 초안에서 근무요일과 함께 정한다. 데모에서 입력을 뺀 것, CTR-21 노무사 검토는 지우는 근거가 아니다.
- 3팀 소유가 아닌 `admin_accounts`·`stores`·`bp_codes` 는 만들지 않고 외래키로만 참조한다.
- 네이밍: 기본키 `{참조 단수}_id`, 관리자 외래키 `{역할}_by`, 날짜 `_date`, 참·거짓 `is_`/`has_`, 삭제 표시 `is_deleted`(삭제 가능한 테이블만, 이력·로그 제외), 유니크는 부분 인덱스.

## 단계

| | 단계 | 검증 |
|---|---|---|
| 1 | 계획 문서 (이 파일) | — |
| 2 | 카탈로그 → 물리 모델 (타입·PK·FK·CHECK·인덱스·is_deleted·공통코드) | 스크립트가 끝까지 돈다 |
| 3 | 정의서 md + schema.sql 생성 | `psql` 로 빈 DB 에 실제 적용해 오류 0 |
| 4 | 화면 생성 (front `docs/erd/physical/`) | 미니 `/erd/` 에서 열림 |
| 5 | 자체 검사: 외래키 대상 존재 · 네이밍 위반 0 · 논리 엔티티 누락 0 | 스크립트가 검사 결과를 출력 |
| 6 | `/okf-ingest` | okf 반영 |
| 7 | 기획 세션 회신 (파일 목록·테이블 수·검사 결과·논리 ERD 와 달라진 점) | — |

커밋·푸시는 재영 승인 뒤.

## 진행 (2026-10-06)

| | 단계 | 결과 |
|---|---|---|
| 1 | 계획 문서 | 이 파일 |
| 2 | 물리 모델 | 38 테이블 · 354 컬럼 · enum 44 · CHECK 22 · EXCLUDE 1 · 고유 10 · 인덱스 32. 결정은 `docs/erd-physical/_model.py` |
| 3 | 정의서 · schema.sql | `docs/raw/2026-10-06-3팀-물리-ERD.md` · `docs/raw/2026-10-06-3팀-schema.sql`. PGlite(PostgreSQL 17.5)에 1팀 → 3팀 순서로 실제 적용해 오류 0. 겹침 금지 · CHECK · 부분 고유가 실제로 막는 것도 확인 |
| 4 | 화면 | front `docs/erd/physical/` 9장 + schema.sql 사본. 그림 겹침 검사 통과. 미니 `/erd/physical/` 은 커밋·푸시·미니 pull 뒤에 보인다 |
| 5 | 자체 검사 | 외래키 0 · 네이밍 0 · 누락 0 (엔티티와 컬럼 둘 다) |
| 6 | okf-ingest | **대기** — 맞는 concept 이 없어 새 concept 이 필요하다. okf-ingest 규칙상 재영 승인 뒤 만든다 |
| 7 | 회신 | 기획 세션 |

다시 만들기: api 루트에서 `python3 docs/erd-physical/_build_physical.py` (front 를 옆에 둔다).
