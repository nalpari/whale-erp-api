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

## 3부 — 알림 템플릿 두 테이블 (2026-10-07, 재영 결정 · 기획 세션 전달)

1차에 「알림 템플릿 관리」를 넣는다. 논리 ERD(front `docs/erd/README.md`)의 `notification_templates`·`notification_template_histories` 를 물리 모델에 더한다. 커밋은 재영 승인 뒤.

| 단계 | 내용 | 검증 |
|---|---|---|
| 1 | `_build_prisma.py` 경계 고침 — 지금은 3팀 표시 줄 아래를 끝까지 다시 써서, 그 뒤에 붙은 1팀 구역(2256b83)을 지운다. 3팀 머리말 다음 구분선부터 다음 구역 구분선 전까지만 바꾼다 | 다시 돌려도 1팀 모델 27 · enum 8 그대로 |
| 2 | `_model.py` — 이름(`notification_template_history_id`, `*_code`), 공통코드 컬럼 2, enum 1(발송 채널 — 알림톡 승인 상태는 뒤에 없앰), 외래키, 필수, 고유 2, CHECK, 인덱스 | 생성기 자체 검사 0 |
| 3 | 정의서 · schema.sql · front `docs/erd/physical/` 재생성, schema.prisma 갱신, enum 이 늘면 `db-enums.generated.ts` | PGlite 에 1팀 → 3팀 적용, 제약 거부 확인 |
| 4 | 회귀 | tsc · lint · 유닛 · e2e |

제약 (기획 세션 제안 셋 + 하나)
- (`channel`, `notification_type_code`) · (`channel`, `send_purpose_code`) 고유 — NULL 끼리는 겹치지 않으니 보통 고유 제약으로 된다(Prisma 로 표현 가능)
- 알림 유형과 발송 용도는 하나만
- 카카오 템플릿 코드는 알림톡일 때만 필수, 아니면 비움 (승인 상태 · 반려 사유는 아래에서 없앰)
- ~~(제안) 알림톡 행은 `body` 를 두지 않는다~~ — 반려(재영 2026-10-07). 본문은 네 채널 모두 필수
- 제목은 운영 알림·앱 푸시·메일 필수, 알림톡은 비운다 (재영 2026-10-07)
- 알림톡 승인 상태·반려 사유·enum 을 없앤다(재영 2026-10-07). 승인 상태 수정 API 설계도 버린다. 알림톡 전용 CHECK 는 「알림톡이면 kakao_template_code 필수, 아니면 비움」만
- 논리 카탈로그(front)에서도 두 칸이 빠졌다(기획 세션이 _build.py 로 재생성)

### 알림톡 문구의 원본 (2026-10-07 재영 B안 — 문서·설계만, 코드 미구현)

원칙: 운영 기준 데이터는 마이그레이션으로 INSERT 만 하고, 그 뒤 변경은 관리자가 화면에서 한다(1팀과 같다).

- 알림톡 문구의 원본은 `notification_templates.body`. `ALIMTALK_TEMPLATES` 문구는 처음 INSERT 할 값으로만 쓴다. 발송할 때 표의 body 를 읽어 변수를 채운다
- 카카오 템플릿 코드 · 변수 목록 · 필수 여부는 코드가 정하고 화면에서 고치지 않는다. 저장 때 허용 밖 변수나 빠진 필수 변수는 400 (다른 채널과 같다)
- 수정 API 는 알림톡 body 도 받고, 알림톡 title 만 받지 않는다. 검수와 다른 문구는 비즈뿌리오가 거절하고 발송 기록에 남는다 — 시스템이 막지 않는다
- 기본 템플릿은 마이그레이션 INSERT — 37건(2026-10-07 A안으로 29 → 37)

### 1팀 메일 8종도 알림 템플릿이 맡는다 (2026-10-07 재영 A안 — 문서·설계만)

- 1팀이 초기 공통코드에서 `MAIL_TYPE` 을 뺐다(9b08053). 그 「메일 템플릿」이 3팀 `notification_templates` 메일 채널이다
- 3팀 발송 용도 5: STAFF_PASSWORD_PIN · STAFF_RESET_LINK · EMAIL_CHANGE_PIN · LEAD_CONFIRMATION · STAFF_INVITATION (앞 둘은 2026-10-07 재영 결정으로 PASSWORD_RESET_PIN · ADMIN_RESET_LINK 에서 이름을 바꿈 — 직원 계정용임이 드러나게. 템플릿 코드는 EMAIL_STAFF_PASSWORD_PIN · EMAIL_STAFF_RESET_LINK)
- 공통코드 `SEND_PURPOSE` 에 1팀 코드값 그대로 8개를 더해 13개: SIGNUP_DONE · SIGNUP_ALERT · BP_REGISTER · PLAT_ADMIN_CREATE · BP_ADMIN_CREATE · PASSWORD_RESET · TEMP_PASSWORD · WITHDRAW_DONE (모두 item_code CHECK 20자 안)
- 기본 템플릿: 메일 22(운영 알림 유형 10 + 3팀 발송 용도 4 + 1팀 8), 전체 37
- 1팀 `mail_send_logs.mail_type_code` 에는 send_purpose_code 값을 담는다. 그 주석과 1팀 발송 코드는 1팀 영역 — api 에서 손대지 않는다
- 스키마 확인: 칸 · CHECK · 고유 바꿀 것 없음. 1팀 메일은 (EMAIL, send_purpose_code) 행이고 제목 · 본문 필수 CHECK 에 그대로 맞는다
- 버린 것: seed 스크립트, 배포 때 알림톡 body 를 상수로 덮어쓰기, 「알림톡 body·title 을 받지 않는 API」, 앞서 물은 (a)·(b)·(c)
- CHECK 는 그대로 맞다: 알림톡 = kakao_template_code 필수 · 제목 없음, body 는 네 채널 모두 필수. 바꿀 것 없음
- 구현 때 바꿀 것: `AlimtalkService` 가 상수 대신 표의 body 로 보내게, 변수 타입은 본문 리터럴이 아니라 코드의 변수 목록에서 뽑게(본문이 DB 에서 오면 리터럴 타입은 첫 판만 설명한다)

### 템플릿 코드 (2026-10-07 재영 — 커밋 전)

- `notification_templates.template_code TEXT NOT NULL`, 고유. 채널 접두(NTF · PUSH · EMAIL · TALK) + `_` + 유형·용도 코드. 공통코드가 아니라 20자 제한 없음
- 호출은 지금처럼 유형·용도 코드로. 템플릿 코드는 화면 · 로그 · 문의 대응용. 수정 API 는 받지 않는다. 기본 37건 INSERT 에 넣는다
- CHECK 판단: 형식 정규식 대신 `template_code_derived` — 값이 「접두 + _ + 유형·용도 코드」와 같아야 한다. 형식 · 접두와 채널의 짝 · 뒤 코드를 한 번에 보장하고, 채널·유형·용도가 바뀌지 않으니 코드만 바꾸는 UPDATE 도 막혀 불변이 된다. 생성 칼럼은 Prisma 가 create 마다 값을 요구해서 쓰지 않는다
- 검증: PGlite 16건 의도대로(접두 틀림 · 뒤 코드 틀림 · 소문자 · 없음 · 코드만 UPDATE 모두 막힘)

### 등록 · 전 항목 수정 (2026-10-07 재영 — 커밋 전)

앞의 「변수 목록은 코드가 정한다」와 「템플릿 코드는 바꾸지 않는다」를 바꾼다.

- 논리 카탈로그(front, 기획 세션이 고치는 중)를 따른다: `notification_templates.is_active`, 새 테이블 `notification_template_variables`, 이력의 이전 템플릿 코드 · 변수 목록(json)
- 물리 쪽 결정
  - `template_code`: 유도식 CHECK 를 빼고 형식 CHECK `^[A-Z][A-Z0-9_]*$` + 고유
  - 변수 테이블: `is_deleted` 추가(목록을 고치면 행이 빠진다 — 네이밍 규칙상 DELETE 하지 않음), (템플릿, 이름) 부분 고유 `WHERE is_deleted = false`, 이름 CHECK `^[^#{}[:space:]]+$`(한글 변수 허용)
  - 이력: 변경 전 행 전체 — 카탈로그에 없는 채널 · 유형 · 용도 · 카카오 코드 · 사용 여부는 `_model.ADD` 로(카탈로그에 들어오면 지운다). variables 는 배열 CHECK
  - 부분 고유 이름 65바이트 → `_model.KEY_NAMES` 로 `notification_template_variables_template_name_key`
- 생성기: 자체 검사에 「한 테이블 안 같은 칸 두 번」 — 카탈로그와 ADD 가 겹쳐 CREATE TABLE 이 깨지는 것을 0건으로 통과시키던 구멍
- 검증: PGlite 21건 의도대로(템플릿 코드 수정 · 채널 수정 · 사용 안 함 · 한글 변수 · 지운 변수 이름 다시 넣기 됨 / 형식 · 중복 · 알림톡 칸 · 변수 중괄호 · 공백 · 이력 배열 막힘)

### 재영 결정 다섯 (2026-10-07 — 커밋 전)

1. 같은 (channel, 유형) · (channel, 용도)에는 하나. 꺼진 것도 칸을 차지 — 지금 고유 그대로
2. 변수 목록은 `notification_templates.variables` jsonb 하나(`[{name, label, isRequired, sampleValue}]`, 순서 = 표시 순서). `notification_template_variables` 와 그 is_deleted · 부분 고유 · KEY_NAMES 항목을 없앴다. DB 는 배열 CHECK 만(템플릿 · 이력 둘 다), 원소 모양 · 이름 규칙 · 「본문 변수 ⊆ 목록」은 저장 때 앱. 이력 다섯 칸은 카탈로그에 들어와 `_model.ADD` 를 지웠다(유형 · 용도는 `*_code` 로 이름 변경)
3. 발송: 필수 변수 없음 · 사용 안 함 · 코드 없음 → 보내지 않고 로그 후 throw. best-effort 는 호출부가 잡는다. 선택 변수는 빈 문자열
4. 템플릿 코드는 기본 37건 포함 모두 수정 가능(운영 정책 NTF-24)
5. notify(유형) 없음 — 채널마다 send(템플릿 코드)
- 검증: PGlite 17건 의도대로

## 4부 — 3팀 공통코드 확정 · 마이그레이션 설계 (2026-10-07 재영 — 커밋 전)

물리 모델 반영
- 급여 항목 전용 표 `payslip_item_masters` (item_code 고유 · 형식 CHECK, category 4종 enum `payslip_item_category`, is_tax_free · is_system_calculated · is_active 기본값). `payslip_items` 는 `payslip_item_master_id` FK + 이름 · 구분 · 비과세 사본, 고유 (payslip_id, payslip_item_master_id). 줄의 구분은 표와 같은 4종 enum(지급 · 공제 2종에서 바뀜)
- `post_audiences.addon_code` → `service_code`(1팀 SERVICE), CHECK · NND 고유 이름도 따라 바뀜
- `work_type` 에 DAY(주간) — DAY · OPEN · MIDDLE · CLOSE
- 결과: 41 테이블, SQL 전용 62(CHECK 29)

마이그레이션 (제안)

| 순서 | 폴더 | 내용 |
|---|---|---|
| 1~3 | `20261006000000_team1_initial` · `…000100_team1_initial_data` · `…000200_team1_public_holidays` | 1팀 (있음) |
| 4 | `20261007000000_team3_initial` | 3팀 DDL = `docs/raw/2026-10-06-3팀-schema.sql` 그대로(생성기 출력). btree_gist 확장 포함 |
| 5 | `20261007000100_team3_initial_data` | 공통코드 그룹 5(sort 13~17, PLATFORM_FIXED, is_bp_applied false) · 상세 43(BP000000) · 급여 항목 29 · 끝에 건수 검사 DO 블록. 메뉴 · 권한은 1팀 전달 사항 14 답을 보고 |
| 6 | `20261007000200_team3_notification_templates` | 기본 알림 템플릿 37(문구 확정 뒤) |

- 검증: PGlite 에 1~3 + 3팀 schema.sql + 5번 초안을 차례로 적용 — 테이블 68, 그룹 19 · 상세 122, 급여 항목 29(지급 11 · 기본 6 · 추가 10 · 원천 2, 비과세 3 · 시스템 계산 3)
- **`pnpm db:migrate` 금지**: Prisma diff 가 3팀→1팀 외래키 28 · NND 고유 1 을 지우고, 1팀 enum 8개 `@@map` 누락으로 1팀 열한 칸을 DROP · ADD 한다. 손으로 쓴 마이그레이션 + `db:deploy` 만
- 1팀 결함: enum 8개에 `@@map` 없음 → 그 칸으로 거르거나 쓰는 쿼리가 `type "public.UseStatus" does not exist` 로 실패(확인함). 1팀이 고칠 일
- DDL 파일은 지금 만들어도 된다 — 단 생성기 출력 그대로, 어느 DB 에든 적용하기 전까지는 덮어써도 되고, 적용한 뒤에는 새 마이그레이션으로만. 개발 DB 적용은 1팀 enum 고침 뒤, `db:deploy` 한 번에 1~5

### 알림 유형 · 발송 용도 공통코드 없앰 (2026-10-07 재영 — 커밋 전)

- 템플릿 = 채널 + `template_name` + `template_code`. 템플릿을 가리키는 값은 모두 템플릿 코드: `notifications.template_code`(외래키 아님 — 보낸 때 값의 기록), 1팀 `mail_send_logs.mail_type_code`(1팀 몫)
- `notification_templates` 의 유형 · 용도 칸, (채널, 유형) · (채널, 용도) 고유, 「유형 · 용도 중 하나」 CHECK 삭제. 이력도 같은 모양
- 수신 설정 묶음 enum `preference_category`(CONTRACT · SCHEDULE · TODO · PAYSLIP) — 템플릿은 앱 푸시만 · 앱 푸시면 반드시(CHECK), `notification_preferences` 의 키. 근로계약서 · 급여명세서는 끌 수 없음 CHECK(운영 정책 NTF-14). enum 이름은 `notification_preference_category` 였다가 ERD 박스 폭을 넘어 칸 이름과 같게 줄였다
- 3팀 공통코드는 5그룹 43개(BANK 25 · FAQ 4 · INQUIRY 5 · INDUSTRY 5 · PLAN_PERIOD 4), sort_order 13~17
- 검증: PGlite 13건 의도대로, 1팀 3개 + 3팀 DDL + 기준 데이터 초안 적용(그룹 17 · 상세 95 · 급여 항목 29)

### DDL 마이그레이션 파일 (2026-10-07 재영 승인)

- `prisma/migrations/20261007000000_team3_initial/migration.sql` — `_build_physical.py` 가 schema.sql 과 같은 본문 + 머리 주석으로 쓴다
- `_model.MIGRATION_APPLIED`(지금 False): 어느 DB 에든 적용하면 True 로. 그 뒤로 생성기는 덮어쓰지 않고, 내용이 달라지면 멈춘다(시험함)
- 검증: PGlite 에 마이그레이션 폴더 7개를 이름 순서대로 적용 — 모두 성공(테이블 72)
- 개발 DB 적용은 재영 확인 뒤. 기준 데이터 마이그레이션은 1팀 전달 사항 14번(메뉴 행) 답을 보고

