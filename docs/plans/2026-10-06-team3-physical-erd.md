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

---

# 2부 — Prisma 변환 (2026-10-06 요청)

- 요청: 기획 세션 전달, 재영 지시. Plane 「데이터 구조」 #127·#134·#225·#246·#271·#209·#110·#197 (상태는 바꾸지 않는다)
- 근거: `docs/raw/2026-10-06-3팀-schema.sql`, `docs/erd-physical/_model.py`, `okf/conventions/naming.md`, front `docs/erd/team1/schema.sql`

## 손대기 전 확인한 사실

| | 상태 |
|---|---|
| `schema.prisma` | 견본 4개뿐 — `Item`·`StockMovement`(품목 API, front `listItems` 가 부름), `Staff`·`Customer`(로그인 주체, `auth.service.ts`·`create-user.ts`) |
| 마이그레이션 | `0_init` · `id_bigint_to_int` · `auth_staff_customers` — 개발 DB 에 모두 적용됨 |
| 개발 DB | `items` · `stock_movements` · `staff` · `customers` 뿐. **1팀 테이블이 없다** |

마지막 줄이 순서를 정한다. 3팀 테이블은 `stores`·`bp_codes`·`admin_accounts` 를 외래키로 가리키므로, 1팀 테이블이 DB 에 생기기 전에는 3팀 마이그레이션이 외래키에서 실패한다.

## 재영에게 묻는 것 (답을 받기 전에 손대지 않는다)

1. 견본 모델 4개
2. 1팀 테이블을 Prisma 모델로 둘지, 정수 외래키 컬럼만 둘지
3. 마이그레이션을 지금 만들지, `schema.prisma` 까지만 할지

## Prisma 가 표현하지 못하는 것 (어느 답이든 남는다)

CHECK 22 · `work_schedules` 겹침 금지(EXCLUDE, `btree_gist`) · 조건 붙은 부분 고유 인덱스 · `NULLS NOT DISTINCT` 고유 · enum 배열 기본값 없음 등은 마이그레이션 SQL 에만 둔다. 따로 목록을 만들지 않는다 — 원문은 `docs/raw/2026-10-06-3팀-schema.sql` 이다(재영 「안해도돼」).

## 결정 (재영 2026-10-06, 기획 세션 전달 「1A · 2B · 3A」)

1. 견본 4개는 그대로, 3팀 모델을 옆에 더한다. 견본 정리는 「직원 근무 앱 접속」 꼭지에서.
2. 1팀 테이블은 모델로 두지 않고 정수 외래키 컬럼만. 외래키 제약은 SQL 쪽.
3. `schema.prisma` 까지만. 마이그레이션·개발 DB 는 건드리지 않는다.

## 진행

| | 결과 |
|---|---|
| 변환 | `docs/erd-physical/_build_prisma.py` 가 물리 모델에서 3팀 부분을 생성해 `schema.prisma` 의 표시 줄 아래만 다시 쓴다. 두 번 돌려도 같다 |
| 수 | 모델 38 · enum 44 · 3팀 내부 관계 43 |
| Prisma 로 못 옮긴 것 | 53 — CHECK 22 · 1팀 외래키 26 · 부분 고유 3 · EXCLUDE 1 · NULLS NOT DISTINCT 고유 1 |
| 검사 | `prisma validate` 통과. PGlite 에 1팀→3팀 schema.sql 을 올리고 `prisma migrate diff` — 3팀 쪽 차이는 NULLS NOT DISTINCT 고유 1건뿐. `db:generate` · tsc 0 · 유닛 82 · e2e 8 |
| okf | `okf/domain/team3-physical-schema.md` 에 Prisma 절 |

남은 것: 커밋·푸시는 재영 승인 뒤. 마이그레이션은 1팀 테이블이 DB 에 생긴 뒤.
