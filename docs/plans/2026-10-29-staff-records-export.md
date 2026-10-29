# 직원 자료 일괄 저장 API (WHALEERP-336)

근거: 운영 정책 RET-09 · ATT-30 · NTF-01, Manyfast 「직원 자료 일괄 저장」 명세, Plane 336 · 338 완료 조건, 목업 `whale-erp-front/docs/mockup/staff/export.html`.
화면은 front `docs/plans/2026-10-29-staff-records-export-screen.md`(Plane 337).

## 정해진 것

- 요청은 BP 마스터(`BM`)와 가맹마스터(`FM`)만 할 수 있다. 각자의 업무 범위 안 자료만 담는다.
- 대상 직원: 업무 범위 점포의 직원 레코드 가운데 임시저장이 아닌 근로계약이 하나라도 있는 사람(재직, 운영 정책 CTR-29). 재직자와, 퇴직일 다음 날부터 3년이 지나지 않은 퇴직자를 담는다(`retired_date >= 오늘 - 3년`, 2026-10-29 재영).
- BP 마스터 파일에서 빼는 직원:
  - 가맹 점포에서 본사 제공 동의를 하지 않은 직원. `hqVisibleWhere` 를 그대로 쓴다.
  - 폐점한 가맹 점포의 직원 전부(ATT-30 · RET-09, 2026-10-29 재영). 가맹마스터 파일과 직영 점포에는 이 규칙을 쓰지 않는다.
- 담는 것:
  - 근로계약서: 처리 완료본(`SIGNED_COPY`) PDF, 종이 계약 날인본(`PAPER_EMPLOYMENT_CONTRACT` · `WAGE_CONTRACT`), 계약 목록 CSV. 발송 원본(`SENT_ORIGINAL`)과 서명 그림(`SIGNATURE`)은 담지 않는다. 처리 완료본은 WHALEERP-131 이 만들 때까지 거의 없다. 기다리지 않는다.
  - 출퇴근 기록 CSV: 시각, 출근·퇴근, 대신 등록(등록자·사유), 확인 필요 사유. 보정 이력은 CSV 를 따로 둔다(전·후 값, 사유, 보정자, 시각).
  - 급여명세서: 발송 완료(`SENT`) 명세서 PDF(`renderPayslipPdf` 를 그대로 씀)와 목록 CSV.
  - 근무스케줄 CSV: 지우지 않은 근무스케줄.
- 빼는 것: 주민등록번호 원본, 신고 정보(`staff_tax_profiles`), 확인자료(`location_access_logs`), 동의 기록. 이 표들은 읽지도 않는다.
- 운영 알림은 보내지 않는다. 진행·완료·실패는 일괄 저장 화면의 상태로만 보인다(NTF-01, 2026-10-13 재영). 실패하면 새로 요청한다.
- 받을 수 있는 기한은 완료한 때부터 7일이다. 지나면 파일을 지운다.
- 목록과 내려받기는 요청한 사람만 쓰는 것이 아니다. 같은 BP · 같은 권한 유형이고, 지금 요청의 점포를 모두 관리하는 마스터라면 쓸 수 있다(2026-10-29 재영). 권한 유형까지 맞추는 것은 가맹마스터 파일(동의로 가리지 않음)이 BP 마스터에게 보이지 않게 하려는 것이다.
- 파일을 만든 뒤 동의 철회 · 폐점이 생기면(2026-10-29 재영, 운영 정책 RET-09):
  - 다 만들 때 파일에 담은 직원 레코드 ID 를 요청 행에 남긴다.
  - BP 마스터 파일은 내려받기 직전에, 담긴 직원 가운데 본사 제공 동의를 철회했거나 가맹 점포가 폐점한 사람이 있는지 본다. 있으면 막고 「파일을 만든 뒤 담긴 직원의 동의나 점포 상태가 바뀌었습니다. 다시 요청해 주세요」를 보인다.
  - 가맹마스터 파일은 원래 동의로 거르지 않으므로 이 확인을 하지 않는다.
  - 이미 내려받은 파일은 손대지 않는다.

## 1팀 엑셀 다운로드와의 관계

`src/excel-exports` 와 `excel_download_logs` 는 1팀 코드라 고치지 않는다. 다른 점은 셋이다. 보관 기간이 24시간과 7일로 다르고, 알림이 메일과 화면 상태로 다르고, 파일이 xlsx 하나와 zip 으로 다르다. 그래서 따로 만든다. 다만 다음 방식은 그대로 따른다.

- 1분 cron 이 `FOR UPDATE SKIP LOCKED` 로 일을 집는다.
- 멈춘 일을 되살리고, 낙관적 갱신으로 마무리한다.
- 진행 중인 요청은 부분 유니크 인덱스로 하나만 둔다.

## 데이터 (마이그레이션 `team3_bulk_exports`)

`bulk_exports` — 일괄 저장 요청 (`bulk_export`, 명명 규칙 대응표)

| 칸 | 뜻 |
|---|---|
| `bulk_export_id` | PK |
| `bp_code_id` | 요청 BP |
| `requested_by` | 요청한 관리자(`admin_accounts`) |
| `role_type_code` | 요청 때 권한 유형(`BM` · `FM`) |
| `store_ids int[]` | 업무 범위 점포(정렬) |
| `scope_key` | `{role}:{store_ids}` — 진행 중 하나만 두는 키 |
| `status` | enum `BulkExportStatus`: `PENDING` · `PROCESSING` · `SUCCEEDED` · `FAILED` (대기 · 만드는 중 · 완료 · 실패) |
| `staff_count` | 담은 직원 수 |
| `staff_member_ids int[]` | 파일에 담은 직원 레코드 ID. 다 만들 때 채운다. BP 마스터 파일을 내려받기 전에 다시 보는 대상 |
| `storage_key` | 파일 키. 기한이 지나 지우면 null 로 바꾼다 |
| `file_name` · `file_size` | |
| `attempt_count` · `failure_reason` | |
| `requested_at` · `started_at` · `completed_at` · `expires_at` | `expires_at = completed_at + 7일` |

- CHECK: `role_type_code IN ('BM','FM')`. `SUCCEEDED` 면 `completed_at` · `expires_at` 이 있다.
- 부분 유니크: `(bp_code_id, scope_key) WHERE status IN ('PENDING','PROCESSING')`.

`bulk_export_download_logs` — 내려받기 이력: `bulk_export_id`, `downloaded_by`, `downloaded_at`.

남겨야 하는 기록이라 `is_deleted` 를 두지 않는다. 요청 행을 몇 년 뒤 지울지는 정하지 않았다. 필요해지면 정한다.

## API (`/staff-members/bulk-exports` — 직원 관리 메뉴 권한)

메뉴 행을 새로 만들지 않는다. 직원 관리 메뉴의 `read` 권한을 받고, 그 위에서 권한 유형(`BM` · `FM`)을 따로 본다. 그 밖의 역할은 403.

| 경로 | 하는 일 |
|---|---|
| `GET /staff-members/bulk-exports/preview?storeIds=` | 대상 직원 수(재직 · 퇴직), 범위 점포 수. 0 이면 화면이 요청 버튼을 끈다 |
| `POST /staff-members/bulk-exports` `{ storeIds? }` | 요청. 비면 관리하는 점포 전부, 관리하지 않는 점포가 섞이면 400, 대상 0명이면 400, 같은 범위가 진행 중이면 409 |
| `GET /staff-members/bulk-exports` | 볼 수 있는 요청 목록 `{ items, total }`. 최근 순 |
| `POST /staff-members/bulk-exports/:id/download` | 완료이고 기한 안이면 5분짜리 내려받기 주소를 주고 이력을 남긴다. 아직이면 409, 기한이 지났으면 410, 볼 수 없으면 404. BP 마스터 파일은 담긴 직원의 동의 · 점포 상태가 바뀌었으면 409 |

`storeIds` 는 화면의 범위 선택기에서 온다(front `scopeStores` — 전체면 빈 값).

## 파일 만들기

- 1분 cron(`BATCH_JOB.BULK_EXPORT`)이 대기 중인 요청을 하나씩 집어 만든다. 만들 때 요청자가 아직 그 BP · 권한 유형 · 점포를 관리하는지 다시 본다. 아니면 실패로 끝낸다.
- 두 번까지 시도한다. 4xx 성격의 오류는 바로 실패로 끝낸다.
- zip 은 `fflate` 로 만든다(직접 의존성 추가, 2026-10-29 재영). PDF 는 압축하지 않고 넣고, CSV 는 압축한다.
- CSV 는 UTF-8 BOM 을 붙여 엑셀에서 한글이 깨지지 않게 한다. 직원 이름 · 휴대전화번호까지만 담는다.
- 안의 구성:

```
직원자료_{BP명}_{YYYYMMDD}.zip
├─ 근로계약_목록.csv
├─ 출퇴근_기록.csv
├─ 출퇴근_보정_이력.csv
├─ 급여명세서_목록.csv
├─ 근무스케줄.csv
└─ {점포명}/{이름}_{직원 레코드 ID}/
   ├─ 근로계약서/{계약 ID}_{파일 구분}.pdf|jpg|png
   └─ 급여명세서/{payslipPdfFileName}
```

- 파일을 읽어 오려고 `StorageService` 에 `get(key)` 를 더한다(`GetObjectCommand`). zip 을 저장하려고 `ZIP` 종류와 `zip` 확장자도 더한다. 키 모양은 `bulk-exports/{bpCodeId}/{uuid}.zip` 이다.
- 급여명세서 PDF 는 직원 쪽 `MyPayslipsService.document` 와 같은 모델로 만든다. 상세 조회(`DETAIL_SELECT` · `toSummary`)를 내보내 함께 쓴다.

## 기한 지난 파일

매일 04:40 에 `BatchLockService.runExclusive` 로 돈다. `expires_at < now` 이고 `storage_key` 가 남은 요청의 파일을 지우고 `storage_key` 를 null 로 바꾼다. 화면은 `expires_at` 으로 「기한 지남」을 보인다.

## 순서와 확인

1. 마이그레이션 · schema · enum 설명 → `pnpm prisma validate`, 일회용 DB 에 적용
2. 대상 직원 판정(범위 · 퇴직 3년 · BP 마스터 가림 · 폐점 가맹) — 단위 테스트를 먼저 쓴다
3. CSV · zip 조립 — 단위 테스트(구성 · BOM · 제외 표를 읽지 않음)
4. 요청 · 목록 · 내려받기 · 권한 — e2e(BA · FA · 직원 403, 범위 밖 400, 진행 중 409, 기한 410, 이력, 만든 뒤 동의 철회 · 폐점이면 BP 마스터만 409)
5. cron · 만료 삭제 — e2e(지운 뒤 `storage_key` null, 내려받기 410)
6. `pnpm lint` · `pnpm build` · `pnpm test` · `pnpm openapi:export`
