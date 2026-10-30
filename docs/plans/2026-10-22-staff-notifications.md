# 직원 알림함 · 알림 수신 설정 API (WHALEERP-265 · 268)

작업 위치: 워크트리 `~/.whale-erp-worktrees/whale-erp-api/stonehenge`, 브랜치 `drowzee`(origin/main `4f03e99`).
근거: Plane WHALEERP-257 · 258 · 265 · 268, staff 목업 `docs/mockup/app/notify.html`(NOTI-1~8), 2026-10-22 재영 결정.
화면은 whale-erp-staff(#266 · #267 · #269).

## 정한 것 (2026-10-22 재영)

- 알림함은 **모든 근무지**의 알림을 보인다(Plane #265 의 「근무지 선택기를 따른다」는 쓰지 않는다). 퇴직해 근무지가 없는 직원도 본다(NOTI-5).
- 이번에는 보여 주는 쪽과 수신 설정만 한다. 근로계약서 발송 · 급여명세서 발송 알림을 만드는 쪽(#259)은 따로다. 지금 직원 알림을 만드는 곳은 근무스케줄 변경(#201)과 TO-DO 수행 임박(#115) 둘이다.
- 수신 설정은 네 묶음 모두 직원이 끈다(NOTI-8, 2026-10-20 — DB CHECK 는 `20261020135907` 에서 이미 지웠다). Plane #268 · #269 본문의 「끄지 못한다」는 옛 내용이다.
- 실제 앱 푸시 발송(#261 · #321)은 앱(기기 푸시 토큰)이 생긴 뒤다. 알림 줄의 발송 결과(NOTI-4)도 그때 붙인다 — 지금은 모두 발송 대기라 보일 것이 없다.

## 알림함 `/me/notifications` (직원 앱 토큰만)

- `GET ?page=&pageSize=` — 내 계정(`notification_recipients.account_id`)이 받은 직원 알림(`notification_target = STAFF`), 지우지 않은 것, **만든 지 14일 안**(NOTI-3)만, 새것부터. `{ items, total, unreadCount }`. 수신 설정과 상관없이 보인다.
- 항목: 받는 사람별 id · 템플릿 코드 · 수신 설정 묶음(템플릿의 값, 없으면 null) · 제목 · 내용 · 긴급 · 읽음 · 만든 시각 · **갈 곳**(`target`).
- 갈 곳은 api 가 관련 업무를 보고 정한다 — 화면 경로가 아니라 무엇을 열지다. 내 재직 소속(`ACTIVE_STAFF`)으로 닿을 수 없거나 관련 행이 없으면 null(화면이 「열 수 없습니다」).
  - `WORK_SCHEDULE` → `{ type, staffMemberId, workDate }` — 지운 근무스케줄도 그 날짜의 달력으로 간다(삭제 알림이 가리키는 곳). 파기돼 행이 없으면 null.
  - `TODO` → `{ type, staffMemberId, todoId }` — 지운 TO-DO 면 null. 그 TO-DO 점포의 내 재직 소속.
  - 그 밖(근로계약 · 급여명세서 — 아직 만드는 곳이 없다)은 null.
- `POST :id/read` · `POST :id/unread` — 한 줄 읽음 바꾸기(NOTI-7). 화면이 알림을 눌러 이동할 때 read 를 부른다. 내 것이 아니거나 14일이 지났으면 404.
- `POST read-all` — 14일 안의 미확인을 모두 읽음. `{ updated }`.

## 수신 설정 `/me/notification-preferences` (직원 앱 토큰만)

- `GET` — 네 묶음(근로계약서 · 근무스케줄 · TO-DO · 급여명세서, enum 순서) `{ items: { category, isEnabled }[] }`. 행이 없으면 켜짐(NTF-14 · 21).
- `PUT :category` `{ isEnabled }` — 그 묶음 한 줄을 upsert 한다. 바꾼 값은 그 뒤에 생기는 알림부터 든다(만드는 쪽이 만들 때 읽는다). 모르는 묶음은 400.

## 시험

- 단위: 갈 곳 정하기(근무스케줄 · TO-DO · 닿을 수 없음), 14일 경계.
- e2e(일회용 DB, UTC): 내 것만 · 14일 경계 · 새것부터 · 미확인 건수, 갈 곳(지운 근무스케줄 · 퇴직 소속 · 지운 TO-DO), 한 줄 읽음 · 안 읽음 · 모두 읽음, 남의 알림 404, 관리자 토큰 403, 수신 설정 기본 켜짐 · 끄기 · 다시 켜기 · 모르는 묶음 400.

## 근로계약서 · 급여명세서 발송 알림 (#259 · #260 · #263, 두 번째 PR)

작업 위치: 워크트리 `~/.whale-erp-worktrees/whale-erp-api/pyramids`, 브랜치 `voltorb`(origin/main `e8f0807`). 2026-10-22 재영(진행해).

- 공통 함수 `noticeStaff`(`src/notifications/staff-notice.ts`) — 템플릿 확인 · 렌더 → 직원 알림 · 받는 사람 → 수신 설정 묶음을 끄지 않았으면 앱 푸시 발송 대기. 템플릿 문제면 만들지 않고 false(업무는 막지 않는다), DB 오류는 던진다. 근무스케줄 저장 알림 · 수행 임박 알림과 같은 순서다(그 둘은 이번에 손대지 않는다).
- **근로계약서 발송(PUSH_CONTRACT_SENT)** — `ContractDeliveryService.prepare` 가 앱으로 받는 길(APP)일 때, 가입한 직원에게만 만든다. 저장 · 재발송 · 수정 요청 계약 고침이 모두 이 길이라 보낼 때마다 하나다. 변수 `근무지` · `날인기한`(한국 날짜 「11월 21일」). 계정만 있는 번호(소속 확인 대기)는 계약이 보이지 않아 만들지 않고, 직원이 스스로 가입하며 서명 대기로 넘어가는 경우(가입 직후 날인 요청 팝업)도 만들지 않는다.
- **급여명세서 발송(PUSH_PAYSLIP_SENT · RESENT)** — 메일이 나가고 상태를 발송 완료로 옮긴 트랜잭션에서, 옮겨졌을 때만 만든다. 변수 `급여월`(급여 기간 시작 달) · `근무지`. 퇴직한 직원도 받는다(NOTI-5).
- 알림함 갈 곳에 `CONTRACT { staffMemberId, contractId }`(내 계약 — 서명 대기 이후, my-contract-scope) · `PAYSLIP { payslipId }`(내가 볼 수 있는 명세서 — 발송된 것 · 3년, my-payslips)를 더한다. 급여명세서는 근무지와 상관없어 `staffMemberId` 가 없다(선택 칸으로 바꾼다).
- #260(수신 설정을 보고 발송 결정)은 `noticeStaff` 가 맡는다. #263(문구 규칙)은 템플릿 코드로 불러 발송하는 것으로 닫는다 — 다시 보낼 때 문구는 처음과 같다(NOTI-6, Plane 본문의 「가른다」는 옛 내용).
- 시험: `noticeStaff` 단위, 계약 발송 준비 단위(가입한 직원만 · 계정만 있는 번호 · 탈퇴 계정), 갈 곳 단위(계약 · 명세서), e2e `test/staff-notices.e2e-spec.ts`(마이그레이션 템플릿 세 개가 호출부 변수로 렌더 · 끈 묶음은 발송 대기 없음 · 알림함 갈 곳).

## 근무스케줄 변경 메일 (WHALEERP-639)

작업 위치: 워크트리 `~/.whale-erp-worktrees/whale-erp-api/angkorwat`, 브랜치 `tyrogue`(origin/main `a400a894`). 2026-10-30 재영 지시 · 기획 세션 분석.
근거: 운영 정책 NTF-14 · NTF-18(v262) — 가입한 직원의 알림톡은 근로계약서 발송 하나로 줄었고(#619), 근무스케줄 변경은 메일로 보낸다.

- **템플릿** `EMAIL_SCHEDULE_CHANGED`(채널 EMAIL, 이름 「근무스케줄 변경 메일」, 묶음 없음 — CHECK `notification_templates_preference_category_push_only`). 본문은 `PUSH_SCHEDULE_CHANGED`(20261030093710)와 같은 문장이고, 제목은 다른 메일처럼 `[WHALE ERP] ` 를 앞에 붙인다. 변수 근무지 · 변경내용 · 링크(버튼). 되돌리기 원본도 같은 값.
- **트랜잭션 안** — `noticeScheduleChange` 는 지금처럼 알림함 줄 · 앱 푸시 발송 대기를 만들고, 앱 푸시 발송 대기를 만든 때(수신 설정 묶음을 끄지 않음)만 보낼 메일(받는 사람 행 · 계정 이메일 · 변수)을 돌려준다. 퇴직 · 계정 없음 · 탈퇴 · 템플릿 문제면 지금처럼 아무것도 없다.
- **커밋 뒤** — `work-schedules.service.ts` 의 다섯 곳(등록 · 일괄 등록 · 지난 주 복사 · 수정 · 삭제)이 커밋된 뒤에 보낸다. 롤백된 저장의 메일은 나가지 않는다. 링크는 `STAFF_APP_URL` origin + `/work`. 메일 설정(`MAIL_*`) · `STAFF_APP_URL` 이 없으면 메일만 건너뛰고 로그를 남긴다. 메일 실패는 저장을 막지 않는다 — 로그만.
- **이력** — `notification_deliveries` 에 channel EMAIL 한 행: 보냈으면 `sent_at` · SUCCEEDED, SMTP 실패면 FAILED(`sent_at` 없음). 보내기 전에 막힌 것(템플릿 꺼짐 · 주소 형식)은 보낸 것이 없어 행을 두지 않고 로그만. `mail_send_logs` 는 MailService 가 남긴다.
- 저장마다 한 통, 일괄 등록 · 지난 주 복사는 직원마다 한 통. 모아 보내기는 불만이 나오면.
- **시험** — 단위: 수신 설정 끔 · 퇴직 · 미가입 · 탈퇴 → 메일 없음, 롤백 → 없음, 메일 실패해도 저장됨, 메일 서비스 null → 알림함만. e2e: 등록 · 수정 · 삭제 · 일괄 등록 한 번씩 메일과 EMAIL 발송 이력.
