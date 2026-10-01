---
type: Reference
title: Naming conventions
description: One Korean term maps to one English identifier across the three repositories; per-layer casing follows from that.
tags: [naming, conventions, database, api, glossary]
status: draft
generated: { by: claude-code/opus-5, at: 2026-10-01T01:23:55Z }
sources:
  - id: naming-raw
    resource: ../../docs/raw/2026-09-30-네이밍-규칙.md
    title: 네이밍 규칙 원자료 (3팀 기획 세션, 2026-10-01 고침)
    last_modified: 2026-10-01T00:00:00Z
---

# Status

**Most of this is a proposal, not a settled rule.** The source document is marked
기획 세션 제안 · 재영 검토 전 as a whole; the two parts confirmed by 재영
(2026-10-01) are [API list responses](#api-list-responses) and the
[영문 식별자 대응표](#영문-식별자-대응표). Treat the rest as the
shape the three repositories are heading for, not as something to enforce in
review yet.

# Why this exists

Three repositories name the same concepts: `whale-erp-api`, `whale-erp-front`
(관리자 웹), and `whale-erp-staff` (직원 근무 앱). The Korean side is settled in the
shared glossary (`whale-erp-v2/CLAUDE.md`); this concept holds the **English
identifier** for each 표준 표기, so one thing is not `employee` here and
`staff_member` there.[^naming-raw]

One identifier per term, and the layers share its root:

```
attendance_records  ↔  attendanceRecord  ↔  /attendance-records  ↔  AttendanceRecord
     DB 테이블              JSON·필드              URL 경로              모델·타입
```

Casing then follows each ecosystem — `snake_case` in the database, `camelCase` in
JSON and TypeScript, `kebab-case` in URLs and filenames. Prisma's `@map` /
`@@map` does the conversion, which is why the database keeps its own spelling
without leaking it into responses.

**No abbreviations.** Not `emp`, `ctr`, `att`. The only exceptions are `id`, `url`,
`bp`, `hq`, `faq`, `todo`, and `rrn` (주민등록번호).

A new concept gets its Korean 표준 표기 into the glossary first, then a row here.

# Where this repository already disagrees

The rules describe where the code is going, not where it is. Four places in
`whale-erp-api` do not match today, and `items` is the module the bundle points at
as the worked example — so copying it now propagates the mismatch.

| Rule | Code today |
|---|---|
| List response is `{ items, total }` | `GET /items` returns a bare array (`ItemResponseDto[]`) — no `total` |
| Paging is `page` · `pageSize` | `ListItemsQueryDto` uses `take` · `skip` |
| 계정 is `account`, 직원 레코드 is `staff_member` | `staff` is the template's auth subject, unrelated to 직원 레코드 |

The last one is already flagged in the source: the `staff` table is to be sorted
out when the 계정 table is built.

The first two are live API contract decisions, and **`/items` already has a
caller**: `whale-erp-front`'s `listItems` (`src/lib/api.ts:145`) requests
`/items?take=` and reads the response as `Item[]`, used by
`src/app/items/page.tsx`. Either change breaks that page, and the parameter
breaks it hard — the global `ValidationPipe` runs with
`forbidNonWhitelisted: true`, so dropping `take` from the DTO turns every
existing list request into a 400 rather than a quietly ignored parameter.
Aligning `/items` therefore cannot be done from this repository alone.

**Decision (2026-09-30): `items` is left as it is.** It is the example, not a
module whose correctness anything depends on, and aligning it would mean
changing `whale-erp-front` in the same breath. The first *real* domain module is
built to these rules instead, and that module becomes the new worked example.
The rows above therefore stay — they describe the example, not a defect queue.
The error-format row is gone for a different reason: the rule changed to keep
Nest's `{ statusCode, message, error }`, so the code was never wrong there.

One thing to carry when that happens: `okf/index.md` still points at
[Items API](/api/items-api.md) as the shape to copy. That pointer moves to the
new module, or the next person copies the mismatch on purpose.

What the code **does** already follow: CHECK constraint names
(`items_sku_not_blank`), index names (`stock_movements_item_id_idx`), module
folders (`src/items/`), and DTO filenames (`create-item.dto.ts`,
`item.response.dto.ts`).

# DB (PostgreSQL + Prisma)

| 대상 | 규칙 | 예 |
|---|---|---|
| 테이블 | snake_case 복수형 | `contracts`, `attendance_records`, `location_access_logs` |
| Prisma 모델 | PascalCase 단수형 + `@@map` | `model Contract { … @@map("contracts") }` |
| 컬럼 | snake_case, Prisma 필드는 camelCase + `@map` | `start_date` ↔ `startDate` |
| 기본키 · 외래키 | `id` · `{참조 단수}_id` | `staff_member_id`, `store_id` |
| 시각 | `_at`, `timestamptz` | `signed_at`, `reviewed_at`, `deleted_at` |
| 날짜만 | `_date` | `start_date`, `birth_date` |
| 참·거짓 | `is_` · `has_` | `is_proxy_entry`, `is_premium_applied` |
| 금액 | `_amount`, 원 단위 정수 | `base_pay_amount` |
| 길이 · 단위 | 단위를 이름 끝에 | `break_minutes`, `radius_m` |
| 상태 값 | Prisma enum, 값은 UPPER_SNAKE | `ContractStatus.PENDING_SIGNATURE` |
| 이력 | 변경 전후는 `_histories`, 사건 기록은 `_logs` | `contract_status_histories`, `payslip_logs` |
| 인덱스 · 키 | `{table}_{cols}_{idx·key·fkey}` | `stock_movements_item_id_idx` |
| CHECK 제약 | `{table}_{col}_{조건}` | `items_sku_not_blank`, `payslip_items_amount_nonzero` |

CHECK constraint names matter more here than elsewhere: they only exist in
migration SQL, never in `schema.prisma`, so the name is the only handle anyone
has on them.

ERD names that mix singular and plural (`attendance`, `schedule_history`) get
pluralised at the next ERD regeneration.

# API (NestJS)

| 대상 | 규칙 | 예 |
|---|---|---|
| 경로 | kebab-case 복수 명사, 동사 금지 | `GET /staff-members/:id/contracts` |
| 상태를 바꾸는 동작 | 하위 경로 + POST | `POST /contracts/:id/resend`, `POST /payslips/:id/cancel-confirmation` |
| 쿼리 파라미터 | camelCase | `?storeId=3&from=2026-09-01` |
| JSON 필드 | camelCase, DB 컬럼명을 그대로 노출하지 않음 | `{ startDate, isProxyEntry }` |
| 모듈 폴더 | 자원 복수 kebab | `src/payslips/`, `src/staff-members/` |
| 파일 | `{자원}.{역할}.ts` | `payslips.service.ts` |
| DTO | 파일 `create-payslip.dto.ts` · 클래스 `CreatePayslipDto` | 응답 `payslip.response.dto.ts` · `PayslipResponseDto` |

The DTO filename rule is not cosmetic: the Swagger CLI plugin only reads files
ending `.dto.ts` or `.entity.ts`, so a response class named anything else gets no
schema at all.

<a id="api-list-responses"></a>

## API list responses

The one part of this document 재영 has confirmed (2026-10-01).

| 항목 | 규칙 |
|---|---|
| 목록 응답 | `{ items, total }` |
| total 구하기 | `findMany` + `count` — 같은 `where`, `$transaction` 으로 묶는다 |
| 페이지 파라미터 | `page`(1부터), `pageSize`(기본 20, 최대 200) |
| 정렬 | 기본 정렬 + 마지막에 `id` |
| 빈 결과 · 마지막 페이지를 넘긴 요청 | `{ items: [], total }` |
| 오류 응답 | Nest 기본 `{ statusCode, message, error }` 유지 |

Three of these carry a trap worth naming.

**`$transaction` does not pin a snapshot.** It sends both queries over one
connection, but under PostgreSQL's default READ COMMITTED each statement still
reads its own snapshot, so a row inserted or deleted between them can leave the
page and `total` off by one. List screens accept that; pinning both to one
snapshot would need `isolationLevel: 'RepeatableRead'`, which this rule does not
ask for. What does matter is the same `where` on both, or `total` counts a
different set than the page shows.

**`id` last in the sort order** is what makes paging stable. Ordering by a
non-unique column alone (a date, a name) leaves rows with equal values in an
undefined order, so the same row can appear on page 1 and again on page 2 while
another is never shown. Appending `id` breaks every tie the same way each time.

**Going past the last page returns `{ items: [], total }`, not a 404.** An empty
page is a valid answer to a valid question, and `total` is the only thing telling
the caller how far it overshot.

The source adds the exception directly: 기존 items 예제(`take`·`skip`, 배열 응답)는
front 가 지금 형식으로 부르고 있어 바꾸지 않고, 새로 만드는 목록 API 부터 적용한다.

# FRONT (Next.js)

Recorded here because the API's route and resource names are what the two
frontends mirror; the frontends are not this repository's code.

| 대상 | 규칙 | 예 |
|---|---|---|
| 라우트 폴더 | kebab-case 영문, API 자원 이름과 같게 | `app/staff-members/[id]/contracts/new/` |
| 파일 | kebab-case | `contract-form.tsx`, `use-payslips.ts` |
| 컴포넌트 | PascalCase | `ContractForm`, `PayslipStatusBadge` |
| 훅 | `use` + 명사 | `usePayslips`, `useStoreScope` |
| API 함수 · 서버 액션 | 동사 + 자원 | `getPayslips`, `createContract`, `resendContract` |
| 이벤트 핸들러 | `handle` 접두 | `handleSubmit`, `handleProxyEntryClick` |
| 쿼리 키 | `[자원, 범위, 조건]` | `['payslips', 'list', { storeId, month }]` |
| 타입 | 자원 PascalCase 단수, enum은 API 값 그대로 | `Payslip`, `PayslipStatus` |
| 화면 문구 | enum → 한글 대응표 한 곳에 | `PAYSLIP_STATUS_LABEL.CONFIRMED = '확정'` |

# 영문 식별자 대응표

2026-10-01 재영 확인. 새 테이블·API·타입은 이 이름을 쓴다.

DB 테이블은 복수형, 모델·타입은 PascalCase 단수형으로 바꿔 쓴다.

## 사람 · 조직

| 표준 표기 | 영문 식별자 | 비고 |
|---|---|---|
| 플랫폼 마스터 / 플랫폼 관리자 | `PLATFORM_MASTER` / `PLATFORM_ADMIN` | 역할 값 |
| BP 마스터 / BP 관리자 | `BP_MASTER` / `BP_ADMIN` | 역할 값 |
| 가맹마스터 / 가맹관리자 | `FRANCHISE_MASTER` / `FRANCHISE_ADMIN` | 역할 값 |
| BP | `bp` | 1팀 테이블, 3팀은 참조만 |
| 본사 | `hq` | |
| 점포 · 근무지 | `store` | 근무지는 직원 레코드의 `store_id` |
| 직영 / 가맹 | `DIRECT` / `FRANCHISE` | `store_type` |
| 계정 | `account` | 로그인 주체. 기존 `staff` 테이블과 다른 것 — 계정 테이블을 만들 때 `staff`를 정리한다 |
| 직원 레코드 | `staff_member` | 계정 1 : 레코드 N |
| 정직원 / 파트타이머 | `FULL_TIME` / `PART_TIME` | `employment_type` |
| 업무 범위 · 범위 선택기 | `scope` · `ScopeSelector` | |

## 채용 · 계약

| 표준 표기 | 영문 식별자 | 비고 |
|---|---|---|
| 근로계약(서) | `contract` | 초안은 상태 `PENDING_SEND`인 계약 |
| 근로계약 상태 6종 | `PENDING_SEND` · `PENDING_SIGNATURE` · `SIGNED` · `REJECTED` · `EXPIRED` · `ENDED` | 발송 대기 · 서명 대기 · 체결 완료 · 거부 · 만료 · 종료 |
| 전자계약 / 종이 계약 | `ELECTRONIC` / `PAPER` | `contract_method` |
| 날인 · 필기 서명 · 날인 기한 | `sign` · `handwritten_signature` · `sign_deadline_at` | |
| 재발송 | `resend` | |
| 초대 · 초대 토큰 | `invitation` · `invitation_token` | |
| 초대 유형 4종 | `SIGNUP` · `REINVITE` · `AFFILIATION_CONFIRM` · `RETURN_CONFIRM` | 가입 초대 · 재초대 · 소속 추가 확인 · 복귀 확인 |
| 가입 불가(만 19세 미만) | `REJECTED_UNDER_AGE` | 초대 상태 값 |
| 연결 보류 · 가입 연결 확인 | `link_hold` · `approve_link` | |
| 본인인증 | `identity_verification` | |
| 신고 정보 | `tax_profile` | |
| 주민등록번호 · 급여 계좌 | `rrn` · `payroll_account` | |
| 주휴일 | `weekly_holiday` | 요일 값 |

## 근무 · 출퇴근

| 표준 표기 | 영문 식별자 | 비고 |
|---|---|---|
| 근무스케줄 | `work_schedule` | |
| 출퇴근 기록 · 출퇴근 현황 | `attendance_record` · `attendance` | 현황은 화면·경로 이름 |
| 출근 / 퇴근 | `CHECK_IN` / `CHECK_OUT` | |
| 보정 | `correction` | |
| 대신 등록 | `proxy_entry` | `entry_method = PROXY` |
| 확인 필요 · 사유 | `needs_review` · `review_reason` | |
| 사유 3종 | `ACCURACY_EXCEEDED` · `OUT_OF_RADIUS_CHECKOUT` · `MOCK_LOCATION` | 위치 오차 초과 · 반경 밖 퇴근 · 위치 조작 감지 |
| 이상 없음 | `mark_reviewed` | 검토만 마치고 값은 그대로 |
| 근무지 반경 | `radius_m` | |
| 위치정보 동의 · 일시 중지 | `location_consent` · `paused_at` | |
| 확인자료 | `location_access_log` | |
| 본사 제공 동의 | `hq_sharing_consent` | |
| 약관·동의 문구 버전 | `terms_version` · `consent_version` | |
| TO-DO | `todo` | |
| 배정 대상 · 수행 방식 | `assignee` · `execution_mode` (`EACH` / `ANY_ONE`) | 각자 수행 / 한 명 수행 |
| 수행 예정 일시 · 긴급 | `due_date` · `due_time` · `is_urgent` | |
| TO-DO 상태 | `PENDING` · `IN_PROGRESS` · `DONE` | 대기 · 진행 중 · 완료 |

## 급여

| 표준 표기 | 영문 식별자 | 비고 |
|---|---|---|
| 급여명세서 | `payslip` | |
| 상태 4종 | `DRAFTING` · `REVIEWING` · `CONFIRMED` · `SENT` | 작성 중 · 검토 중 · 확정 · 발송 완료 |
| 확정 취소 · 처리 이력 | `cancel_confirmation` · `payslip_log` | |
| 검토 대기 사유 4종 | `MISSING_ATTENDANCE` · `AFTER_CONTRACT_END` · `CONTRACT_CHANGED` · `DEDUCTION_MISSING` | |
| 지급 항목 / 공제 항목 | `earning` / `deduction` | 줄 하나는 `payslip_item` |
| 기본 공제 / 추가 공제 | `BASIC` / `ADDITIONAL` | |
| 비과세 | `is_tax_free` | |
| 3.3% 원천징수 | `business_income_withholding` | 적용 여부 `is_withholding_applied` |
| 연장·야간·휴일 가산 적용 여부 | `is_premium_applied` | |
| 주휴수당 · 연장수당 | `weekly_holiday_pay` · `overtime_pay` | 항목 코드 |
| 일괄 저장 | `bulk_export` | |

## 고객지원 · 알림

| 표준 표기 | 영문 식별자 | 비고 |
|---|---|---|
| 공지사항 · FAQ · 문의사항 · 도입문의 | `notice` · `faq` · `inquiry` · `lead` | |
| 노출 대상 | `audience` | |
| 게시 상태 | `PUBLISHED` · `DRAFT` · `PRIVATE` | 게시 · 임시저장 · 비공개 |
| 문의 답변 상태 | `RECEIVED` · `IN_PROGRESS` · `ANSWERED` | 접수 · 처리중 · 답변완료 |
| 운영 알림 · 앱 푸시 | `notification` · `push` | |

# Changing it

The source of this document is the 기획 세션's. A change arrives as a **new**
dated file in each repository's `docs/raw/`, and each repository re-runs
`/okf-ingest` — the existing raw file is never edited in place, which is why it
is safe to list as a source here.

[^naming-raw]: 네이밍 규칙 원자료 (3팀 기획 세션, 2026-10-01 고침)
