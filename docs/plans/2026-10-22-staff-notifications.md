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
