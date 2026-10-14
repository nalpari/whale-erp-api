# Directory Update Log

## 2026-10-14
* **Update**: [Inquiry and lead handling](/api/inquiries.md) · [Operations notifications](/api/notifications-api.md) · [Platform admins](/api/platform-admins.md) · [Whale ERP API](/api/whale-erp-api.md) — api #32 재영 리뷰 반영. `ADMIN_WEB_URL` 읽기를 `src/common/admin-web-url.ts` 하나로 합쳤다(http(s), 운영은 https 만, 끝의 / 를 떼고 경로는 받으며 링크는 그 뒤에 이어 붙임). admin-signup 의 `readAdminWebUrl` 은 비었을 때 던지는 것만 더하고, 플랫폼 관리자 메일도 같은 함수를 쓴다. 도입문의 처리중 · 답변완료 때 `NTF_LEAD_ANSWERED` 를 플랫폼 운영자에게 보낸다(사건 키 `{ID}:{상태}`, 2026-10-14 재영). 도입문의 답변 메일은 후속 WHALEERP-588. 상담 완료일은 비어 있을 때 채우고(CNT-11), 문의 답변 메일의 `sentBy` 는 비운다.
* **Update**: [Inquiry and lead handling](/api/inquiries.md) · [Mail](/api/mail.md) · [Whale ERP API](/api/whale-erp-api.md) · [Notices and FAQ management](/api/posts.md) — PR 리뷰 반영. 여섯 경로 모두 응답 상태를 UPDATE 와 같은 트랜잭션에서 읽는다. 문의 첫 답변의 운영 알림 · 메일은 서로 묶이지 않고 응답이 기다리지 않는다(SMTP 대기로 인한 타임아웃 · 엉뚱한 409 방지, 서버가 내려가면 잃는 대가). 메일 실패 로그는 오류 이름 · 코드만 남긴다(SMTP 메시지의 받는 주소). `ADMIN_WEB_URL` 은 경로 없는 origin 만 받고, 운영에서 메일 설정이 비면 기동 때 error 로그. `OptionalMailService` 타입. 이메일이 없는 등록자도 운영 알림은 받는다고 바로잡았다. posts 개념의 출처에 `src/common` 두 파일을 더했고, `whale-erp-api` 본문에 `InquiriesModule` 을 적었다.
* **Creation**: [Inquiry and lead handling](/api/inquiries.md) — 문의사항 · 도입문의 처리(WHALEERP-274): `POST /inquiries/:id/processing` · `POST /inquiries/:id/replies` · `PUT /inquiries/:id/internal-memo`, `POST /leads/:id/processing` · `PUT /leads/:id/reply` · `PUT /leads/:id/internal-memo`. 처리중은 상태 조건, 답변 · 메모는 읽은 updatedAt 조건으로 겨룬다. 문의 첫 답변만 등록자에게 `NTF_INQUIRY_ANSWERED` 와 `EMAIL_INQUIRY_ANSWERED`(버튼 `ADMIN_WEB_URL` + `/support/inquiries/{id}`)를 따로 보낸다. 도입문의 답변 메일은 템플릿이 없어 아직 보내지 않는다. 리뷰 반영: 문의 답변 응답 상태를 트랜잭션 안에서 읽고(알림 · 메일 대기 중 남의 저장을 돌려주지 않음), 알림 쪽 DB 오류도 삼키며, 내부 메모 `internalMemo` 키를 필수로 했다(빠진 키로 지워지지 않게).
* **Update**: [Operations notifications](/api/notifications-api.md) — 동작은 그대로다. 로그용 실패 사유 `reasonOf` 를 export 해 문의 답변 알림 · 메일 실패 로그도 Prisma 메시지 대신 코드를 남긴다.
* **Update**: [Mail](/api/mail.md) — 메일 없이도 떠야 하는 업무 모듈용 `optionalMailServiceProvider`(`OPTIONAL_MAIL_SERVICE`, `MailService | null`).
* **Update**: [Whale ERP API](/api/whale-erp-api.md) — `AppModule` 에 `InquiriesModule`, `.env.example` 에 `ADMIN_WEB_URL`. `/leads` 중 `@Public()` 은 접수 경로뿐이고 관리자 처리 경로는 `LeadsAdminController` 라고 적었다.
* **Update**: [Notices and FAQ management](/api/posts.md) — 동작은 그대로다. `sameMillisecond` · `updatedAt` 검증 · 경로 ID 검사를 `src/common/updated-at.ts` · `route-id.ts` 로 옮겨 문의 처리와 같이 쓴다. `IsUpdatedAt` 은 Swagger 플러그인이 보지 못하는 `pattern` 을 `ApiProperty` 로 직접 적는다.
* **Update**: [Platform admins](/api/platform-admins.md) — PR #29 머지 블로커 반영. 이메일을 바꿔 임시 비밀번호를 무효로 했으면 「미발송」을 다시 켠다(로그인 수단이 없는 계정이 정상으로 보이던 것). 미발송 해제는 계정 행을 먼저 잠그고 다음 문장에서 비밀번호를 확인한다 — 한 문장 `UPDATE … WHERE EXISTS` 는 잠금을 기다린 뒤에도 문장 시작 스냅숏으로 판정해 그 사이 무효화를 못 봤다. 초기화 응답의 새 `updatedAt` 은 그 사이 다른 저장이 없을 때만 준다(있으면 옛 값 — 다음 저장이 409).
* **Update**: [Platform admins](/api/platform-admins.md) — PR #29 머지 블로커 반영. 메일 설정이 없으면 비밀번호 초기화를 아무것도 쓰기 전에 503 으로 거절한다(지운 비밀번호를 대신할 새 비밀번호가 아무에게도 가지 않음). 미발송 해제와 새 `updatedAt` 을 `UPDATE … RETURNING` 한 문장으로 읽는다(따로 읽으면 다른 관리자의 저장 시각을 받아 409 없이 덮어씀). 이메일을 바꾸면 쓰지 않은 임시 비밀번호를 같은 트랜잭션에서 무효로 한다(옛 주소로 나간 비밀번호).
* **Update**: [Naming conventions](/conventions/naming.md) — `2026-09-30-네이밍-규칙.md` 2026-10-14 고침을 옮겼다: 메일 템플릿 표의 「운영 알림 짝」을 걷고 운영 알림 · 메일 분리(운영 정책 NTF-03), 알림 템플릿의 기본 문구 칸(`default_*`, NOTIFY-17 · 18)을 적었다(재영).
* **Update**: [Contracts API](/api/contracts-api.md) — 2026-10-13 결정 반영: 임시저장 필수 칸에 고용 형태가 요건(운영 정책 CTR-02) 자체에 들어 있음, 대체 확인 문구 「기존 근로계약을 대체하시겠습니까?」, 휴일근무 두 칸은 화면(front #15)에서 받지 않음(칸은 남김), 범위 판단은 직원이 정해진 것은 그 직원의 본사 제공 동의로 — 코드는 아직 점포 단위이고 api #21 머지 뒤 바뀐다. 다른 점포 겹침 메시지에서 「근무 시간을 고쳐 주세요」를 뺐다(CTR-26).
* **Update**: [Notification templates](/api/notification-templates.md) — 채널이 바뀌어 기본 문구가 지금 채널 규칙에 맞지 않으면 되돌리기가 400 이다(NOTIFY-18).
* **Update**: [Operations notifications](/api/notifications-api.md) — 템플릿 코드를 바꾸면 지난 운영 알림의 구분 표시가 옛 코드로 나오거나 비어 보일 수 있고 감수한다(운영 정책 NTF-24).

## 2026-10-13
* **Update**: [Contracts API](/api/contracts-api.md) · [Staff retirement](/api/staff-retirement.md) — api #21 리뷰 블로커 반영(main 병합): `canManageStaffAt` 이 본사 제공 동의를 필수 인자로 받는다. 직원이 정해진 기존 계약(상세 · 이어 쓰기 · 삭제 · 목록)은 그 직원의 동의로, 새 계약 근무지와 `GET /stores` 는 점포 단위로 판단한다(2026-10-13 재영). 목록은 가려지는 점포에서 동의한 직원의 계약만 낸다. 이어 쓰기는 근무지를 옮길 때만 새 점포를 점포 단위로 묻는다.
* **Update**: [Operations notifications](/api/notifications-api.md) — 운영 알림 · 메일 분리(운영 정책 NTF-03 v114, 2026-10-13 재영): notify 는 메일을 붙이지 않고 업무 쪽이 `MailService.send` 를 따로 부른다. 메일 버튼은 업무 화면으로 바로 가고 #249(짝 메일)는 취소됐다. 메일 버튼이 `/notifications/{id}/open` 을 쓴다는 문장을 걷었다.
* **Update**: [Authentication](/api/auth.md) — api #28 재리뷰 후속: 재설정 링크 메일이 나간 뒤 앞선 링크 · 핀을 닫는 트랜잭션이 실패해도 201 이고 error 로그를 남긴다(남은 것은 다음 발급 · 새 비밀번호 저장 때 닫힘). 닫힌 시각은 발급 시각이 아니라 실제로 닫은 시각이다. 발송기는 `maskedVariables: ['링크']` 로 이력에서 링크를 직접 가린다.
* **Update**: [Authentication](/api/auth.md) · [Mail](/api/mail.md) — api #28 리뷰(재영) 반영: 재설정 링크를 `MailService`(템플릿 `EMAIL_STAFF_RESET_LINK`)로 보낸다. `MAIL_*` 가 없으면 기동은 하고 발급만 503(`readOptionalMailConfig`, `createMailTransport`), Noop 은 어디서도 쓸 수 없다. 앞선 링크 · 핀은 메일이 나간 뒤 이번 발급보다 앞선 것만 닫고, 실패하면 닫지 않는다. 토큰은 fragment(`#token=`)로 옮겨 접근 로그에 남지 않는다.
* **Update**: [Authentication](/api/auth.md) — 재설정 링크 자체 리뷰 반영: 발송 실패 503 문구가 앞 링크도 닫혔다고 알리고, 운영에서 `STAFF_APP_URL` 이 비면 기동 때 error 로그, 잠금 안에서 링크 행을 못 찾아도 401. 링크 주소는 `STAFF_APP_URL` 의 origin + 고정 경로(주소의 경로는 버림)라고 바로잡았고, 요청 제한 목록에 `PasswordResetLinkController` 를 더했다(관리자 경로는 제한 없음). Noop 발송기를 출처로 따로 뒀다.
* **Update**: [Authentication](/api/auth.md) — 재설정 링크 리뷰 Minor 반영: 발급이 잠금 안에서 탈퇴 · 퇴직을 다시 보고, 발송 실패는 원인을 먼저 남긴 뒤 지우며(지우기 실패도 503), 발송기 계약(확실히 안 나갔을 때만 던짐 · 오류에 링크 없음)을 적었다. 동시 저장 e2e 는 다섯 번 겨룬다.
* **Update**: [Authentication](/api/auth.md) — 관리자 초기화 재설정 링크(WHALEERP-172): 관리자 `POST /staff-members/:id/password-reset-links`(201 발송 시각 · 기한, 404 · 409 · 429 · 503), 직원 `POST /auth/account/password-reset-links/verify · reset`. 핀 · 링크 공통 `applyNewPassword`(핀으로 정해도 링크를 닫는다), 발송기 자리는 Noop(`MAIL_*` 미정이라 MailModule 을 쓰지 않음), `STAFF_APP_URL`(운영 https), 요청 제한 계정 축에 본문 `token`.

* **Update**: [Platform admins](/api/platform-admins.md) · [Mail](/api/mail.md) · [Whale ERP API](/api/whale-erp-api.md) — PR #29 머지 블로커 반영. main(PR #28)의 「메일 설정이 없어도 api 는 뜬다」에 맞춰 `PlatformAdminsModule` 이 `MailModule` 을 import 하지 않고 `readOptionalMailConfig` · `createMailTransport` 로 발송기를 직접 만든다. `MAIL_*` 나 `ADMIN_WEB_URL` 이 비면 기동하고 등록 · 초기화는 「초기 비밀번호 미발송」으로 남는다(반만 넣은 메일 설정 · 잘못된 주소는 기동 때 던짐). 삭제는 읽은 계정 상태까지 그대로일 때만 써서, 그 사이 사용으로 바뀐 PM 을 마지막 PM 확인 없이 지우지 않는다.
* **Update**: [Platform admins](/api/platform-admins.md) — PR 재리뷰 반영. 미발송 해제는 메일로 보낸 임시 비밀번호가 아직 유효할 때만 한다(동시 초기화에서 실패한 메일이 「보냄」으로 보이던 경합), 마무리 쓰기 실패 로그의 stack 에서 원문 첫 줄을 뗀다, SMTP 전 단계의 메일 실패는 원인 메시지를 남긴다.
* **Update**: [Platform admins](/api/platform-admins.md) — PR 리뷰 반영. 초기화 감사 이력(`초기 비밀번호 → 초기화`)을 트랜잭션 안에서 쓰고, 미발송 표시는 등록 · 초기화 때 먼저 켜 두었다가 메일이 나간 뒤에만 끈다. 초기화 응답 `updatedAt` 은 늘 값이 있다. 메일 실패 · 마무리 쓰기 실패 로그에 오류 원문(받는 주소 · Prisma 인자)을 남기지 않는다. 등록 아이디도 앞뒤 공백을 지운다.
* **Update**: [Platform admins](/api/platform-admins.md) — 2차 리뷰 반영. 마지막 PM 잠금을 `FOR NO KEY UPDATE` 로(외래키 확인과의 교착), 초기화 응답에 새 `updatedAt`(거짓 409 방지), 탈퇴 계정은 모든 경로에서 404, 초기화는 읽은 이메일 그대로일 때만, `updatedAt` 을 ms 범위로 비교하는 이유를 적었다.
* **Update**: [Platform admins](/api/platform-admins.md) — 리뷰 반영. 호출자가 PM · PA 가 아니면 메뉴 권한이 있어도 403, 삭제 · 초기화는 읽은 대상이 그대로일 때만 쓴다(그 사이 삭제 · 승격이면 409), 커밋 뒤 미발송 표시 · 초기화 이력 실패는 로그만 남기고 응답은 그대로, `inactiveCount` 가 상태 조건을 보지 않는다는 것을 적었다.
* **Update**: [Platform admins](/api/platform-admins.md) — 아이디 중복 확인 `GET /platform-admins/login-id-availability`(등록 권한, `{ available }`)을 더했다. 등록 화면이 칸을 벗어나거나 Enter 를 칠 때 묻는다.
* **Add**: [Platform admins](/api/platform-admins.md) — 플랫폼 관리자 관리 API(`/platform-admins`)와 메뉴 권한 판정(`MenuPermissionsService`, role_group_menus 의 조회 · 등록 · 수정 · 삭제). 마스터 보호 · 본인 보호, 사용 중 PM 한 명 이상(잠금), `updatedAt` 비교로 동시 수정 409, 초기 · 초기화 비밀번호는 메일로만. 메일 바로가기 버튼(`#{링크}`)은 BP 회원가입과 같이 `ADMIN_WEB_URL` 로 채운다 — 링크를 선택으로 바꾸려던 마이그레이션은 지웠다.
* **Update**: [Mail (Gmail SMTP)](/api/mail.md) · [Whale ERP API](/api/whale-erp-api.md) — `MailModule` 이 `PlatformAdminsModule` 을 통해 `AppModule` 에 들어와, 이제 모든 환경에 `MAIL_USERNAME` · `MAIL_PASSWORD` · `ADMIN_WEB_URL` 이 필요하다.
* **Update**: [Contracts API](/api/contracts-api.md) — api #25 재리뷰 블로커: 이름이 달라 새 레코드를 만드는 분기도 대체로 계약을 잃은 가입 전 레코드를 지운다. 이름은 받을 때 앞뒤 공백을 지운다(NFC). POST · PUT 409 설명에 `CONTRACT_IN_PROGRESS` · `WORK_TIME_OVERLAP`.
* **Update**: [Contracts API](/api/contracts-api.md) — api #25 머지 블로커 반영. ① 다른 점포 근무 시간 겹침은 퇴직한 레코드의 계약을 퇴직일까지만 본다 ② 409 `WORK_TIME_OVERLAP` 은 겹쳤다는 문장만 — 요일 · 시각 · `overlaps` 를 뺐다(CTR-26, 재영) ③ 대체는 계약마다 행을 잠그고 상태 · 점포 · 번호를 다시 읽어, 바뀌었거나 0건이면 409. 이어 쓰기는 지금 번호와 새 번호를 오름차순으로 둘 다 잠근다(`lockPeople`) ④ 가입 전 레코드는 번호와 이름이 같을 때만 다시 쓴다. 임시저장도 고용 형태 필수(CTR-02).
* **Update**: [Contracts API](/api/contracts-api.md) — 계약 중복 검사(WHALEERP-129, 2026-10-13 김민식 결정). 같은 점포 · 같은 번호의 진행 중 계약(임시저장 · 발송 대기 · 서명 대기)은 409 `CONTRACT_IN_PROGRESS` 로 묻고 `replaceContractIds` 로 대체(임시저장은 지우고 발송 대기 · 서명 대기는 종료 + 이력), 가입 전 직원 레코드는 다시 쓴다. 초안 저장은 다른 점포 · 같은 번호 계약과 근무 시간이 겹치면 409 `WORK_TIME_OVERLAP`(겹친 요일 · 시간만, 점포는 드러내지 않음). 잠금은 사람(번호) 단위. api #19 리뷰 참고 항목도 반영 — api #12 칸 저장 · 상세, `IsDateOnly` 날짜와 integer 상한(500 → 400), 임시저장의 계약 방식 선택, 삭제 · 이어 쓰기의 계약 행 잠금(교착 500), 범위 검사를 트랜잭션 밖으로. [Employment Contract Batch](/api/employment-contract-batch.md) 의 「AppModule since 2026-10-07」을 고쳤다.
* **Creation**: [Notification templates](/api/notification-templates.md) — 알림 템플릿 관리 API(`/notification-templates` 목록 · 상세 · 등록 · 수정 · 되돌리기 · 사용 여부, WHALEERP-572 · 573 · 581)와 저장 검사 `validateTemplate`. 기본 문구 칸 `default_*`(`20261013153521_team3_notification_template_defaults`, NOTIFY-17 · 18). [Mail](/api/mail.md) 의 「Not built」에서 템플릿 관리를 뺐다(기본 템플릿 40건 표는 기획 세션이 4e9a705 로 고쳤다).
* **Update**: [Naming](/conventions/naming.md) — 기본 템플릿 코드 37건 → 40건. 표에 빠져 있던 `PUSH_PAYSLIP_RESENT` · `EMAIL_PAYSLIP_SENT` · `EMAIL_PAYSLIP_RESENT` 를 더했다(마이그레이션 `20261007000100_team3_initial_data` 와 맞춤).
* **Update**: [Team 3 physical schema](/domain/team3-physical-schema.md) — 문의사항 · 도입문의에 처리 시작 관리자 · 일시 칸(`processing_started_by` → `admin_accounts`, `processing_started_at`)과 「둘은 함께 채우거나 함께 비운다」 CHECK 를 더했다(Plane #274). 처리중을 거치지 않고 답변하면 둘 다 NULL. 3팀 물리 스키마 개념의 SQL 전용 제약 개수(98, CHECK 59, 1팀 외래키 34)를 생성기 값으로 맞췄다. `20261013151714_team3_inquiry_lead_processing_start`.
* **Update**: [Operations notifications](/api/notifications-api.md) · [Team 3 physical schema](/domain/team3-physical-schema.md) — 알림을 눌러 갈 업무 화면은 알림을 만드는 업무 쪽이 `link` 로 넘긴다(NOTIFY-16, 2026-10-13 재영). `notifications.link`(nullable, CHECK `notifications_link_internal_path`, `20261013150113_team3_notification_link`), 목록 · 읽음 응답에 `link`.
* **Update**: [Operations notifications](/api/notifications-api.md) · [Team 3 physical schema](/domain/team3-physical-schema.md) — NOTIFY-12~15 결정(2026-10-13 재영) 반영. `notifications.title` 칸(`20261013144718_team3_notification_title`, 논리 ERD → `_model.py` → 생성기)에 제목을 따로 담고 body 첫 줄로 나누던 임시안을 지웠다. `storeManagers` 가 직원 레코드를 받아 가맹 점포 직원이 본사 제공에 동의했으면 BP 마스터 · BP 관리자도 받는다.
* **Creation**: [Operations notifications](/api/notifications-api.md) — 운영 알림 공통 함수 `OpsNotificationService.notify`, 수신자 판정 셋(`platformOperators` · `storeManagers` · `activeAdmin`), 운영 알림함 API(`GET /notifications` · `POST /notifications/:id/read` · `POST /notifications/read-all` · `DELETE /notifications`). 업무 흐름은 건드리지 않고 각 업무 일감이 함수를 부른다(Plane #247, 2026-10-13 재영). 제목은 body 첫 줄(NOTIFY-12 결정 대기), 가맹 점포는 가맹 쪽만 받음(NOTIFY-13 결정 대기).
* **Update**: [Authentication](/api/auth.md) — 이메일 찾기 성공은 그 번호의 계정이 모두 맞았을 때만 실패 횟수를 지운다(api #20 리뷰, 노영주). 일부만 맞으면 찾은 것은 주고 횟수는 그대로 둔다 — 같은 번호의 내 계정을 맞혀 가며 남의 계정을 대입하지 못하게.
* **Update**: [Whale ERP API](/api/whale-erp-api.md) · [Authentication](/api/auth.md) · [Notices and FAQ management](/api/posts.md) — api #22 재영 리뷰 반영. 운영에서 `TRUST_PROXY` 가 비면 기동을 막는다(도입문의 IP 한도가 한 버킷이 되는 것을 막음 — auth 의 「Before production」 질문을 이것으로 정함). 도입 예정 시기 `null` 이 500 이던 것을 고쳤다. 429 문구를 재영 결정대로 바꿨다(중복 「이미 접수된 문의가 있습니다…」, 한도 「잠시 후 다시 시도해 주세요」). 잠금 키를 전화번호 · 이메일로 나눴고, 자유 입력의 NUL 을 400 으로 막는다(`NO_NUL` 을 `src/common/no-nul.ts` 로 옮겨 공지 · FAQ 와 같이 씀). 상담하지 않은 도입문의는 자동으로 지우지 않고 관리자가 처리한다.
* **Update**: [Whale ERP API](/api/whale-erp-api.md) · [Employment Contract Batch](/api/employment-contract-batch.md) — 도입문의 PR 리뷰 반영: 도입 예정 시기 빈 문자열을 400 으로 막고(공통코드 확인 없이 `''` 가 저장되던 것), 없는 공통코드 오류를 칸 이름으로 알린다. 배치 문서에 잡 이름 `staff-retire` · `lead-purge` 와 요청 경로의 advisory lock 키(`lead-intake`)가 같은 공간을 쓴다는 점을 적었다.
* **Update**: [Whale ERP API](/api/whale-erp-api.md) — 도입문의 리뷰 반영: 10분 중복 확인과 저장을 advisory lock(`lead-intake`) 아래 한 트랜잭션으로 묶어 동시 제출이 두 행이 되지 않는다. 전화번호에 대표번호(15xx · 16xx · 18xx)를 받는다. IP 한도는 관리자 웹이 `X-Forwarded-For` 를 넘기고 `TRUST_PROXY` 가 그 서버를 가리켜야 방문자별이 된다는 연동 조건을 적었다.
* **Update**: [Whale ERP API](/api/whale-erp-api.md) — 도입문의 접수 `POST /leads`(Plane #295)와 상담 완료 1년 뒤 파기 배치 `lead-purge` 를 더했다. IP 시간당 5건, 같은 전화번호 · 이메일 10분 안 429. 접수 확인 메일 · 운영자 알림은 아직 보내지 않는다.
* **Update**: [Contracts API](/api/contracts-api.md) — PR #19 머지 블로커 4건 반영. ① 급여액은 고용 형태와 상관없이 시급(DTO · 응답 설명 · 테스트 값). ② 재직 중 확인은 가입한(`JOINED`) 재직 직원만 본다 — 가입 전 레코드는 기본값이 `EMPLOYED` 라 거부 · 만료 뒤 그 사람의 새 초안을 막았다. ③ 저장 · 이어 쓰기의 재직 확인 · 초대 유형 판별 · 쓰기를 한 트랜잭션에서 `contracts:{storeId}:{phone}` advisory lock 아래 한다. ④ 목록 · 상세 · 저장 · 이어 쓰기 · 삭제와 `GET /stores` 를 관리자 업무 범위로 거른다 — 관리하지 않는 점포와 본사 역할에게 직영이 아닌 점포는 목록에서 빠지고 계약은 404, 사용 중이 아닌 계정은 목록 403. `AdminScopeService.canManageStaffAt`(점포로 묻는 `canManageStaffMember`)을 더했다 — [Staff member list](/api/staff-members.md) · [Staff retirement](/api/staff-retirement.md) · [Notices and FAQ management](/api/posts.md) 의 출처 시각만 갱신, 동작은 그대로다.
* **Add**: [Contracts API](/api/contracts-api.md) — 근로계약 `GET` · `POST /contracts`(목록 · 근로계약서 초안 저장), 임시저장 이어 쓰기 `GET` · `PUT /contracts/:contractId`,
  임시저장 삭제 `DELETE /contracts/:contractId`(행을 지움, 그 계약에만 쓰인 초안 직원 레코드까지)와 근무지 선택지 `GET /stores` 를 더했다.
  `ContractsModule` · `StoresModule` 을 `AppModule` 에 넣어 [Whale ERP API](/api/whale-erp-api.md) · [Employment Contract Batch](/api/employment-contract-batch.md) 를 맞췄다 — 만료 배치도 이제 돈다.
  로컬에서만 쓰던 브랜치(pikachu · lucario)의 작업을 main 위로 옮긴 것이고, 그 브랜치의 스키마 변경은 main 에 이미 들어가 있어 뺐다.

* **Update**: [Team 3 physical schema](/domain/team3-physical-schema.md) — 「동의 칸을 아직 아무도 읽지 않는다」는 문장을 고쳤다. `hidesPersonalData` 가 읽고, 철회한 행은 버전 · 시각을 남기므로 불리언만 본다. 출처에 `admin-scope.service.ts` 를 더했다. [Staff member list](/api/staff-members.md) 의 점포 조건 설명을 「가림 대상 점포」로 다듬고 동의가 직원마다임을 적었다(리뷰 반영).
* **Update**: [Staff member list](/api/staff-members.md) · [Staff retirement](/api/staff-retirement.md) — 본사 제공 동의 칸(`is_hq_sharing_consented`)을 가림에 반영했다. 동의한 가맹 점포 직원은 BM · BA 에게 가리지 않고, 개인 칸으로 걸러도 남으며, 직원 단위 API 도 열린다. `hidesPersonalData` 가 동의를 세 번째 인자로 받는다.
* **Update**: [Staff member list](/api/staff-members.md) · [Staff retirement](/api/staff-retirement.md) — PR #13 머지 블로커 반영. 가린 행은 `staffMemberId` 도 null 이고, `canManageStaffMember` 가 본사 역할(BM · BA)에게 직영이 아닌 점포의 직원을 거부해 퇴직 미리보기 · 처리도 404 다. 기준은 `hidesPersonalData` 하나다.
* **Update**: [Authentication](/api/auth.md) — 이메일 찾기 `POST /auth/account/email-find-attempts`(WHALEERP-178). 이름(NFC) · 휴대전화번호 · 생년월일이 맞는 탈퇴 아닌 계정의 이메일을 가려 목록으로 준다(앞 2글자 · 마지막 1글자, 3글자 이하면 첫 글자). 넣은 번호의 HMAC(키는 `JWT_SECRET`)으로 5회 · 5분 잠금, advisory lock 아래 마지막 시도(id 순)로 세고 막을 때 warn 로그. 요청 제한의 계정 축이 본문 `phone` 을 프로세스 키 HMAC 으로 읽는다. 생년월일 검증은 퇴직일과 같은 `IsDateOnly`(`src/common/is-date-only.ts`)로 옮겼고, `isLocked` 는 타입 가드가 됐다. 429 는 `lockExpiresAt` 유무로 번호 잠금과 요청 제한을 가른다(OpenAPI 에 적음). CLAUDE.md 인증 절도 맞췄다.
* **Update**: [Team 3 physical schema](/domain/team3-physical-schema.md) — 직원 레코드에 본사 제공 동의 칸 4개(여부 · 문구 버전 · 동의 시각 · 철회 시각)와 CHECK 3개를 더했다(#137). `20261013091102_team3_staff_member_hq_sharing_consent`. 채용과 초대 ERD 배치를 고쳤다.
* **Update**: [Notices and FAQ management](/api/posts.md) — PR #18 리뷰(재영 결정) 반영: 본문은 평문이고 화면이 이스케이프한다, 사용 중지된 FAQ 카테고리는 게시 · 내용 수정 때만 막아 비공개 전환 · 삭제는 된다, 카테고리 그룹 사용 여부도 본다, 카테고리 코드 모양 검사와 제목 200자 · 본문 20,000자 상한, `post_audiences` 행 DELETE 는 삭제 표시 예외.
* **Update**: `2026-09-30-네이밍-규칙.md` 2026-10-13 고침을 [네이밍 규칙](/conventions/naming.md) 에 옮겼다 — 삭제 표시 예외에 노출 대상 연결 표 `post_audiences` 행 삭제를 더했다(재영, api #18).
* **Update**: `2026-09-30-네이밍-규칙.md` 2026-10-13 고침을 [네이밍 규칙](/conventions/naming.md) 에 옮겼다 — 삭제 표시 예외에 임시저장(`DRAFT`) 근로계약 행 삭제를 더했다(재영).
* **Creation**: [Notices and FAQ management](/api/posts.md) — 공지사항 · FAQ 관리 API(`PostsModule`, `/posts`, WHALEERP-272 · 273 저장 · 332 일부). 플랫폼 관리자만, 게시에는 노출 대상 필요, 동시 수정 409(읽은 `updatedAt` 조건), 지움 표시와 이미 지운 글 409. 첨부 · 사용자 쪽 조회 · 되살리기는 아직 없다.
* **Update**: [Staff retirement](/api/staff-retirement.md) — `parseDateOnly` 가 0~99 년을 1900 년대로 받아들이던 것을 막았다(`0026-10-14` 가 1926 년으로 저장되던 것). 퇴직일 · 게시 기간 입력에 함께 걸린다.
* **Update**: [Notices and FAQ management](/api/posts.md) — PR 리뷰 반영: 동시 수정은 같은 밀리초 안 비교, `updatedAt` 은 시간대 필수, 공백 · NUL 제목 · 본문은 400, FAQ 카테고리 「없음」과 「없거나 사용 중지」를 다른 문구로.
* **Update**: [Staff retirement](/api/staff-retirement.md) — 출처 `admin-scope.service.ts` 에 플랫폼 관리자 확인(`isPlatformAdmin`)이 더해졌다. 퇴직 처리 동작은 그대로다.

## 2026-10-12
* **Update**: [Staff member list](/api/staff-members.md) — PR 리뷰 반영. `joinState` · `employmentType` 쉼표 목록, 가림은 직영이 아니면 가리고 점포를 못 찾으면 500, 수락한 초대는 재발송 불가. 우선순위 · 쿼리 수 설명을 코드에 맞췄다. [Staff retirement](/api/staff-retirement.md) 의 admin-scope 출처 시각도 갱신.
* **Add**: [Staff member list](/api/staff-members.md) — 직원 목록 API(WHALEERP-329). index · naming 의 worked example 문장을 이 개념으로 바꿨다.
* **Update**: [Authentication](/api/auth.md) — 직원 앱 BFF 뒤에서 IP 축을 모두가 나눠 쓰던 것(staff 요청 1번). `TRUST_PROXY` 에 적은 프록시만 믿고 `X-Forwarded-For` 의 클라이언트 IP 로 센다 — `true` · 단계 수는 기동 단계에서 거절한다. 로그인 · 재설정의 IP 한도를 30 → 60/분으로 올렸다(매장 와이파이 출근 시각 기준).
  PR 전 리뷰 반영: IPv4 전체를 믿게 되는 IPv6 대역(`::/8`, `::ffff:10.0.0.0/8`)과 `/0` 도 거절하고, IP 축은 IPv6 를 /64 로 묶고 헤더의 포트 · 대괄호를 떼며 주소가 아니면 소켓 주소로 센다. 운영에서 빈 `TRUST_PROXY` 처리와 대역 폭 하한은 운영 반영 때 정하기로 하고 「Before production」 에 적었다.
* **Update**: [Authentication](/api/auth.md) — `GET /auth/account/me` 를 더했다(staff 요청 2번). 로그인 응답의 account 가 그 순간 값이라 연결 보류 해제 · 이메일 변경을 다시 로그인할 때까지 몰랐던 것. 요청 제한의 두 축을 모두 건너뛴다(인자 없는 `@SkipThrottle()` 은 `default` 만 건너뛰어 e2e 가 잡았다). 경로 목록 정책 테스트에 확인 사유와 함께 더했다.
* **Update**: [Team 3 physical schema](/domain/team3-physical-schema.md) — 근로계약에 비과세 수당 3종(식대 · 자가운전보조금 · 육아수당), 월 근로시간 5종(`numeric(5,1)`),
  연차휴가 · 퇴직금 조항 칸과 0 이상 CHECK 를 더했다. 급여액(`wage_amount`)은 고용 형태와 상관없이 시급만 둔다(물리 비고는 `_model.NOTE`), 기존 정직원 행의 월급은 NULL 로 비운다. `20261012182445_team3_contract_allowances_hours_terms`.
* **Update**: [Whale ERP API](/api/whale-erp-api.md) — 플랫폼 공통코드 관리 API(`CodeGroupsModule`, `/code-groups`)를 더했다. 그룹 · 상세 코드 조회와 패널 단위 저장, BP 적용(각 BP 에 아직 없는 행만 넣음 — 다시 적용하면 기존 BP 에는 그 뒤 추가한 상세 코드가, 새로 사용 중이 된 BP 에는 전부가 들어간다. 상세 코드나 사용 중인 고객 BP 가 없으면 409). 지우지 않은 사용 중 PM · PA 계정만 쓸 수 있고, 동시에 같은 코드를 만들면 409.
* **Update**: [Team 3 physical schema](/domain/team3-physical-schema.md) — 근로계약 근무 조건 · 급여 조건 컬럼화(`contract_work_days`, 47개)와 임시저장(`DRAFT`), 초대 채널 앱 푸시를 main 에 올렸다.
  세 마이그레이션은 enum 설명 규칙 전에 공용 DB 에 적용돼 이름 · 내용을 그대로 두고, `20261012170702_team3_enum_type_comments_contract_terms` 가
  `invitation_channel` · `pay_month` · `contract_status` 설명을 채운다. 논리 카탈로그(`contract_work_days`)는 front `88bb87c` 기준이다.
* **Update**: [whale-erp-api](/api/whale-erp-api.md) · [Team 3 physical schema](/domain/team3-physical-schema.md) — enum 한글 출처를 타입 설명(`COMMENT ON TYPE`)으로 옮겼다(재영, 1팀 합의). 마이그레이션 `20261012144829_team3_enum_type_comments` 가 54개(3팀 46 · 1팀 8)에 설명을 붙이고, `pnpm enums:generate`(`scripts/build-enum-labels.mjs`)가 PGlite 에서 읽는다. `_build_enum_labels.py` 를 지웠고 `_build_physical.py` 가 schema.sql 에 `COMMENT ON TYPE` 을 쓴다. `db-enums.generated.spec.ts` 가 schema.prisma 와 대조한다. 1팀 8개가 `GET /enums` 에 들어왔다.
* **Update**: [Team 3 physical schema](/domain/team3-physical-schema.md) — 도입문의 `leads` 에 `replied_by`(→ admin_accounts) · `replied_at` · `updated_at` 을
  `_model.ADD` 로 더했다(2026-10-12 재영, Plane #274). 마이그레이션 `20261012110123_team3_leads_reply_tracking`. 생성기를 다시 돌리며
  정의서 · schema.sql 의 `account_status` 에 빠져 있던 `WITHDRAWN` 과 schema.prisma 에 남아 있던 근무 유형 주석이 함께 맞춰졌다.
* **Update**: [Team 1 physical schema](/domain/team1-physical-schema.md) — 1팀 DDL 과 테이블 정의서를 3팀처럼 `docs/raw/2026-10-12-1팀-schema.sql` · `2026-10-12-1팀-물리-ERD.md` 에 둔다. front `docs/erd/team1/schema.sql` 은 없앴다(재영).

## 2026-10-08
* **Update**: [Staff retirement](/api/staff-retirement.md) — PR #8 팀 리뷰 반영. 자정 배치가 직원마다 트랜잭션을 따로 열어, 한 명의 실패가 그날 밤 전체를 롤백하지 않는다(실패는 직원 ID 로 남기고 다음 실행이 다시 시도). 미리 보기 검사 범위와 변경 이력 모양을 정확히 적었다.
* **Update**: [Staff retirement](/api/staff-retirement.md) — 3팀이 퇴직 처리 이력 칸 설명을 「참고용 처리 시점 계약 종료일」로 고친 것(`20261008000600`)을 반영했다. 「낡은 설명」 안내를 지웠다.
* **Update**: [Staff retirement](/api/staff-retirement.md) — main 의 스키마 변경(근무스케줄 확정 단계 제거, 계약 상태 NULL 허용)에 맞췄다. 스케줄 삭제 이력에서 확정 상태를 뺐다.
* **Update**: [Team 1 physical schema](/domain/team1-physical-schema.md) · [Team 3 physical schema](/domain/team3-physical-schema.md) — PR #6(메일 · 알림톡) 머지와 합쳤다. 양쪽 기록과 출처를 살렸다.
* **Update**: [Authentication](/api/auth.md) — 요청 제한의 Bearer 스킴을 가드처럼 대소문자 구분 없이 읽는다(소문자 스킴이 공유 IP 버킷으로 떨어지던 것).
* **Update**: [Authentication](/api/auth.md) — 두 번째 리뷰 후속. 갱신은 IP 축을 빼지 않고 600/분으로 올렸다(무작위 토큰 무제한 방지), 로그아웃만 IP 축에서 뺀다.
  핀 재설정도 잠금 뒤 탈퇴를 다시 본다. 「같은 시간」을 「같은 scrypt 비용, DB 왕복 몇 ms 차이는 감수」로 바로잡고, 핀 요청 표에 503 을 적었다.
  지어 넣었던 정각 시각(06:00 · 08:00)을 실제 커밋 시각으로 바꿨다(이 문서와 1팀 · 3팀 물리 스키마).
  `AuthUser` 를 종류별 유니언으로(account 는 sid 필수), 핀 하루 한도 · 핀 닫힘을 warn 로그로, 운영 Noop 발송기는 기동 때 error 로그,
  더미 해시는 기동 때 계산한다.
* **Update**: [Authentication](/api/auth.md) — 리뷰 후속. 핀 재설정의 규칙 위반 400 도 잠금 안에서 핀을 다시 확인한 뒤에 답하고, 로그인 검증 중
  탈퇴는 `ACCOUNT_NOT_FOUND`(계정 없이)로 남긴다. 핀 저장 중 연결 실패도 204, 무작위 갱신 토큰은 사실상 제한이 없다는 점을 적었다.
* **Update**: [Team 3 physical schema](/domain/team3-physical-schema.md) · [Team 1 physical schema](/domain/team1-physical-schema.md) — `schema.prisma` 의 `AccountStatus` 주석에 탈퇴를 더했다(값은 이미 있었다). 내용 변화는 없다.
* **Update**: [Authentication](/api/auth.md) — PR #7 리뷰를 반영했다. 로그인 성공 처리를 행 잠금 트랜잭션으로 묶어 다시 읽고(그 사이 잠김 → 429,
  재설정·탈퇴 → 401), 탈퇴한 계정의 남은 접속을 갱신·요청마다 거부한다. 핀 검증·새 비밀번호 해시는 잠금 밖에서 하고 잠금 안에서 같은 핀인지
  다시 본다. 핀 발송은 기다리지 않고, 저장 중 DB 오류도 204, 운영에서 발송기가 없으면 계정과 상관없이 503 이다. 갱신·로그아웃은 IP 축에서 빼고
  토큰 해시로 센다 — trust proxy 를 켜지 않아 프록시 뒤에서는 모두가 한 IP 라서다. 로그인·재설정의 IP 축은 인프라 결정으로 남겼다.
* **Update**: [Authentication](/api/auth.md) — 3팀이 핀 쿨다운 칸 둘을 지운 것(`20261008000000_team3_password_reset_pin`)을 반영했다. 「쓰지 않고 둔다」를 「지웠다」로.
* **Update**: [Authentication](/api/auth.md) — 비밀번호 재설정(핀)을 더했다(WHALEERP-169 · 170 · 171, 노영주 결정). 경로 3개, 핀과 새 비밀번호 설정을
  10분 한 시계로 묶고, 확인 뒤 토큰 대신 변경 요청에 핀을 다시 실어 재검증하며, 쿨다운 없이 핀당 5회로 닫는다. 계정 행 잠금으로 세는 이유,
  핀 판정이 비밀번호 규칙보다 먼저인 이유, 192 의 비밀번호 규칙, 발송기 자리를 적었다. 3팀 스키마는 그대로다.
* **Update**: [Team 3 physical schema](/domain/team3-physical-schema.md) — 초대 수신 채널에 앱 푸시(`PUSH`)를 더했다(소속 추가 확인 · 복귀 확인용).
  `20261008000900_team3_invitation_channel_push`.
* **Update**: `2026-09-30-네이밍-규칙.md` 2026-10-08 고침을 [네이밍 규칙](/conventions/naming.md) 에 옮겼다 — 「근무 · 출퇴근」의 근무 유형 4종(`DAY`·`OPEN`·`MIDDLE`·`CLOSE`, enum `work_type`) 줄을 지웠다(재영).
* **Update**: [Team 3 physical schema](/domain/team3-physical-schema.md) — 근무스케줄에서 근무 유형을 뺐다(재영). `work_schedules.work_type` 칸과 enum `work_type` 을 지우는 `20261008000800_team3_work_schedule_work_type_drop`. 적용 전 개발 DB work_schedules 0행 확인. 네이밍 원자료의 근무 유형 줄은 기획 세션 몫이다.
* **Update**: [Team 3 physical schema](/domain/team3-physical-schema.md) — 체결 완료 근로계약은 시작일 필수(CHECK `contracts_start_date_required_when_signed`, 재영).
  마이그레이션 `20261008000700_team3_contracts_start_date_required_when_signed`. 적용 전 개발 DB 에 걸리는 행이 없음을 확인했다. SQL 전용 제약 수를 지금 schema.sql 기준으로 고쳤다(75 · 1팀 외래키 31 · CHECK 39).
* **Update**: [Team 3 physical schema](/domain/team3-physical-schema.md) — 비밀번호 재설정 링크 · 이메일 찾기 시도 두 표와 퇴직 처리 이력 설명(재영 승인, 노영주 요청).
  `20261008000600_team3_password_reset_links_email_find`. 3팀 모델 46개.
* **Update**: [Team 3 physical schema](/domain/team3-physical-schema.md) — 근로계약서 근무 장소 `contracts.work_location`(text, NULL 허용)을
  `_model.ADD` 로 더했다. 마이그레이션 `20261008000500_team3_contract_work_location`. 네이밍 대응표 줄은 기획 세션 몫이다.
* **Update**: [Team 3 physical schema](/domain/team3-physical-schema.md) — `contracts` 는 키(PK · staff_member_id · store_id · created_by)만 NOT NULL 로 두고
  나머지를 풀었다(임시저장용). 생성기에 `_model.KEYS_ONLY_NOT_NULL` 을 더했고 마이그레이션은 `20261008000400_team3_contracts_keys_only_not_null`
  (work_terms · wage_terms 는 있을 때만). 마이그레이션 합 = schema.sql 과 개발 DB 모양에서 도는 것을 PGlite 로 확인했다.

* **Add**: [Staff retirement](/api/staff-retirement.md) — 퇴직 처리 · 변경 · 취소 · 미리 보기와 자정 배치(WHALEERP-584). 계약과 퇴직을 분리해 계약 종료일은 바꾸지 않고, 퇴직일만 저장한 뒤 다음 날 0시(KST) 배치가 퇴직으로 바꾸며 스케줄 · 개인 TO-DO 배정 · 대기 계약을 정리한다. 관리 범위 밖은 404.
* **Update**: [Naming conventions](/conventions/naming.md) — 원자료의 기본 템플릿 코드 표에서 PUSH_SCHEDULE_CHANGED 이름을 「근무스케줄 변경」으로(재영).
  개발 DB 의 기본 행은 `20261008000300_team3_work_schedule_confirm_drop` 이 옛 이름일 때만 고친다.
* **Update**: [Team 3 physical schema](/domain/team3-physical-schema.md) — 근무스케줄 확정 단계를 없앴다(재영, 운영 정책 PAY-14 v90).
  `work_schedules.confirm_status` 와 enum 을 지우는 `20261008000300_team3_work_schedule_confirm_drop`.
* **Update**: [Kakao Alimtalk (Bizppurio)](/api/alimtalk.md) — 문자 대체 발송을 기본 꺼짐으로 바꿨다. `BIZPPURIO_SMS_FROM` 이 비면 `from` · `resend` · `recontent` 를 보내지 않고 기동도 막지 않는다(어떤 템플릿을 문자로 대체할지 기획 결정 전, PR #6 팀 리뷰).
* **Update**: [Team 3 physical schema](/domain/team3-physical-schema.md) — `alimtalk_send_logs` 에 `UNIQUE (reference_key)` 와 `message_key` 조회 인덱스를 더했다(결과 리포트를 이력에 맞출 키, PR #6 팀 리뷰). 마이그레이션 `20261008000200` 은 머지 전이라 제자리에서 고쳤다(공유 개발 DB 적용 여부는 접속 정보가 없어 확인하지 못함).
* **Update**: [Mail (Gmail SMTP)](/api/mail.md) · [Kakao Alimtalk (Bizppurio)](/api/alimtalk.md) — 메일 본문을 운영 정책 NTF-22 에 맞췄다(PR #6 팀 리뷰 CRITICAL). 템플릿 본문은 일반 글로 보고, 본문 전체를 이스케이프 · 줄바꿈 `<br>` 로 바꿔 공통 메일 틀(머리 · 꼬리)에 넣고, 버튼 링크 변수는 「바로가기」 버튼으로 붙인다(`http(s)` 만). text 파트도 보낸다. 전에는 본문을 완성된 HTML 로 보아 기본 템플릿이 링크 없이, 줄바꿈 없이 나갔다. 버튼 링크 변수는 `maskedVariables` 에 없어도 이력에서 언제나 가린다(토큰). `renderTemplate` 의 `escapeBody` 를 없애고 `links` 를 돌려준다.
* **Update**: [Kakao Alimtalk (Bizppurio)](/api/alimtalk.md) · [Mail (Gmail SMTP)](/api/mail.md) · [Team 3 physical schema](/domain/team3-physical-schema.md) — PR 직전 리뷰 반영. 이력 행이 거절할 id(`related` · `sentBy` · `adminAccountId`)는 보내기 전에 던진다. `BIZPPURIO_SMS_FROM` 이 전화번호 모양이 아니면 기동을 멈춘다. 네트워크 오류 메시지에 원인 코드를 싣는다. 기본 템플릿 수 37 → 40, 지운 `ALIMTALK_TEMPLATES` 언급과 버튼 링크 설명을 바로잡았다.
* **Update**: [Kakao Alimtalk (Bizppurio)](/api/alimtalk.md) — 문자 대체 발송에 버튼 링크 변수(`isButtonLink`)의 값을 본문 끝에 붙인다(문자에는 버튼이 없어 초대 링크가 빠지던 것). 색인 설명을 DB 템플릿 · 발송 이력 · 문자 대체로 고쳤다. 리뷰 지적.
* **Update**: [Team 3 physical schema](/domain/team3-physical-schema.md) — 알림톡 발송 이력 마이그레이션 이름을 `20261008000200_team3_alimtalk_send_logs` 로 바꿨다. main 의 `20261008000100_team3_inquiry_attachments` 와 타임스탬프가 겹쳤다(내용은 그대로). 3팀 테이블 44 · SQL 전용 제약 70(CHECK 35).
* **Update**: [Kakao Alimtalk (Bizppurio)](/api/alimtalk.md) — 알림톡이 실패하면 같은 본문을 문자로 대체 발송한다(`resend` · `recontent`, 발신번호 `BIZPPURIO_SMS_FROM` 새 필수 키). EUC-KR 90바이트까지 SMS, 넘으면 LMS(제목 `[WHALE ERP]`). 대체 여부는 결과 리포트에만 나온다.
* **Update**: [Kakao Alimtalk (Bizppurio)](/api/alimtalk.md) · [Mail (Gmail SMTP)](/api/mail.md) — 발송 실패 때 `Error` 가 아닌 값(null 포함)이 던져져도 그 값을 문자열로 FAILED 이력에 남기고 그대로 다시 던진다. 이력 INSERT 가 그런 값으로 실패해도 던지지 않는다(전에는 TypeError 로 바뀌고 이력이 빠졌다). 알림톡 문서의 입력 오류 목록·`variables` 이름·「로그를 남긴다」 서술을 코드에 맞췄다. 리뷰 지적.
* **Update**: [Kakao Alimtalk (Bizppurio)](/api/alimtalk.md) · [Team 3 physical schema](/domain/team3-physical-schema.md) — 알림톡 발송 이력의 요청 키 칸 `ref_key` → `reference_key`(약어 금지, front PR #2 리뷰). 마이그레이션 `20261008000100_team3_alimtalk_send_logs` 는 로컬 DB 에 적용 기록이 없고 브랜치가 푸시 전이라 제자리에서 고쳤다(공유 개발 DB 는 조회하지 않음). `AlimtalkService.send` 반환도 `referenceKey`. 비즈뿌리오 요청 필드 `refkey` 는 외부 이름이라 그대로다.
* **Update**: [Kakao Alimtalk (Bizppurio)](/api/alimtalk.md) · [Team 3 physical schema](/domain/team3-physical-schema.md) — 알림톡 발송 이력 `alimtalk_send_logs`(마이그레이션 `20261008000100_team3_alimtalk_send_logs`). 비즈뿌리오 시도마다 한 행(접수 SUCCEEDED · 실패 FAILED), 가린 본문 · 숫자만 번호 · 관련 업무 · `sent_by`. 이력 INSERT 실패는 던지지 않고 이름 · 코드만 로그. 논리 ERD 는 front PR #2.
* **Update**: [Team 1 physical schema](/domain/team1-physical-schema.md) — 견본 삭제와 개발 DB 적용(2026-10-07)에 맞췄다(3팀 전달).
  1팀 마이그레이션 3개가 적용돼 고칠 수 없다는 것, 3팀이 1팀 테이블로 거는 외래키 28개, `db:migrate` 금지와 1팀 enum `@@map` 누락(78e6f5b)의 교훈,
  메일 8종이 `notification_templates` 의 `EMAIL` 행이라는 것과 `mail_send_logs.body` 의 임시 비밀번호 마스킹 필요를 적었다. `items` CHECK 예시를 지웠다.
* **Update**: `2026-09-30-네이밍-규칙.md` 「인증 · 계정」의 `mail_type_code` 비고를 알림 템플릿 `template_code` 로 고쳐(1팀 영역, 1팀 전달 사항 15번) [Naming conventions](/conventions/naming.md) 에 반영했다.
* **Update**: [Team 3 physical schema](/domain/team3-physical-schema.md) — 문의 첨부파일 `inquiry_attachments`(재영, 운영 정책 CNT-18).
  삭제 표시 없음(등록 때만 붙임), 10MB · 종류 3가지 CHECK, 「문의당 5개」는 순서 1~5 CHECK + (문의, 순서) 고유로 DB 가 막는다.
* **Update**: [Team 3 physical schema](/domain/team3-physical-schema.md) — 비밀번호 재설정 핀 쿨다운을 없앴다(재영, 노영주 제안).
  `20261008000000_team3_password_reset_pin` 이 쿨다운 칸 둘과 CHECK 를 지우고 EMAIL_STAFF_PASSWORD_PIN 본문을 10분으로 고친다.
  5회 실패는 칸 없이 `attempt_count = 5` 로 본다.
* **Update**: [Kakao Alimtalk (Bizppurio)](/api/alimtalk.md) — 알림톡이 `notification_templates` 의 ALIMTALK 행에서 문구를 읽고 `kakao_template_code` 로 보낸다. 코드 레지스트리 · 컴파일 단계 변수 타입 · 제목을 없앴다. 렌더와 조회를 `src/notification-templates/` 로 옮겨 [Mail (Gmail SMTP)](/api/mail.md) 과 같이 쓴다. 발송 이력 테이블 `alimtalk_send_logs` 는 front 논리 ERD 반영을 기다린다(제안서 `docs/plans/2026-10-07-alimtalk-send-logs-table.md`).

## 2026-10-07
* **Update**: [Authentication](/api/auth.md) — 직원 근무 앱 로그인(`POST /auth/account/login` · `refresh` · `logout`)이 들어와 다시 썼다.
  기기별 접속 상태(`auth_sessions`), 갱신 토큰 회전 없음(마지막 사용 + 30일, 샘플과 다름), 가드가 요청마다 `sid` 로 접속 상태를 확인하는 이유(로그아웃 뒤 15분 창),
  5회 틀리면 5분 고정 잠금(429, 행 잠금으로 셈), 탈퇴 계정은 없는 계정처럼 다룸, 퇴직·휴면은 막지 않음, 관리자 웹 로그인이 가져갈 규칙. index 한 줄도 맞췄다.
* **Update**: [Team 3 physical schema](/domain/team3-physical-schema.md) — 계정 상태에 `WITHDRAWN`(탈퇴)을 더했다(노영주 결정, WHALEERP-168).
  동결된 `20261007000000_team3_initial` 은 그대로 두고 새 마이그레이션 `20261007100000_account_status_withdrawn` 으로 더한다. 휴면은 값으로 두지 않는다(ACC-18).
  `_model.py` 와 enum 라벨(`db-enums.generated.ts`)은 맞췄고, 생성기를 돌릴 수 없는(front 가 옆에 없음) `docs/raw` DDL·물리 ERD 는 값 하나만큼 DB 보다 뒤처져 있다.
* **Update**: [Mail (Gmail SMTP)](/api/mail.md) — 254자를 넘는 받는 주소는 정규식에 넣기 전에 거부한다. 주소 정규식이 `@` 뒤 `.` 이 많고 끝이 맞지 않는 입력에서 제곱으로 되돌아가 10만 자에 수 초 이벤트 루프를 멈췄다(PR #6 머지 블로커). 로그에 남길 SMTP 오류 문장도 가리기 전에 1000자로 자르고, 잘린 자리에 걸친 단어는 `…` 로 바꿔 반쪽 주소가 새지 않게 한다(같은 종류의 제곱 시간).
* **Update**: [Mail (Gmail SMTP)](/api/mail.md) — 이력 INSERT 실패 로그에서 오류 메시지를 뺐다(Prisma 메시지는 주소 · 본문을 찍는다, 대신 이름 · 코드 · id). SMTP 오류 속 주소는 대소문자와 상관없이 가린다. 30초 타임아웃은 기다림마다의 한도이지 발송 전체 상한이 아님을 적었다.
* **Creation**: [Mail (Gmail SMTP)](/api/mail.md) — `src/mail/` 메일 발송 공통 기능. 템플릿 HTML 을 채워 Gmail 로 보내고 시도마다 `mail_send_logs` 에 남긴다(가림은 호출부 지정). 시드 EMAIL 본문이 아직 텍스트라 실제 발송 전에 HTML 로 바꿔야 한다.
* **Update**: [Team 3 physical schema](/domain/team3-physical-schema.md) — 직원 퇴직 처리(재영, 운영 정책 CTR-24 · CTR-25). `staff_member_retirement_logs`
  (처리 · 취소, 앞당긴 계약마다 한 줄)와 `todo_status_histories.unassigned_staff_member_id`, 적용 이후 첫 차이 마이그레이션
  `20261007000300_team3_staff_retirement` 과 그 검증 방법(마이그레이션 전체 적용 DB = 1팀 DDL + 새 schema.sql DB)을 적었다.
* **Update**: `2026-09-30-네이밍-규칙.md` 삭제 표시 절의 예외(`todo_assignees` 는 DELETE, 배정 해제는 `todo_status_histories` 에 기록 — 퇴직 처리, 2026-10-07 재영)를 [Naming conventions](/conventions/naming.md) 에 반영했다.
* **Update**: `2026-09-30-네이밍-규칙.md` 「템플릿 사용 여부 · 변수 목록」 줄의 변수 모양에 `isButtonLink`(선택)를 더해 [Naming conventions](/conventions/naming.md) 에 반영했다(2026-10-07 재영 확정). [Team 3 physical schema](/domain/team3-physical-schema.md) 의 변수 모양 한 줄도 맞췄다.
* **Update**: [Team 3 physical schema](/domain/team3-physical-schema.md) — 기본 알림 템플릿 40건 마이그레이션, 버튼으로 붙는 링크 변수는
  `isButtonLink` 표시로 「필수 변수는 본문에」 검사에서 뺀다(이름 「링크」로 예외를 두지 않음).
* **Update**: [Team 3 physical schema](/domain/team3-physical-schema.md) — 용어집에 들어온 표준 표기 「수신 설정 묶음」을 `preference_category` 설명에 붙였다. 정의서 · enum 한글은 이미 같았다.
* **Update**: [Team 3 physical schema](/domain/team3-physical-schema.md) — 3팀 기준 데이터 마이그레이션 `20261007000100_team3_initial_data`
  (공통코드 5그룹 43 · 급여 항목 29, 끝에 건수 검사)를 적었다.
* **Update**: 원자료(df8c7df)의 견본 예시 정리를 [Naming conventions](/conventions/naming.md) 에 옮겼다 — 인덱스 · CHECK 예를 실제 DDL 이름으로,
  계정 · 알림 템플릿 줄을 새 문구로. 「표의 견본 예시는 원자료를 기다린다」와 목록 응답의 items 예외 문단을 지웠다. 원자료와 표 줄 차이 0.
* **Update**: [Team 3 physical schema](/domain/team3-physical-schema.md) — 개발 DB(whale-erp)의 견본 테이블을 지우고(백업은 세션 scratchpad)
  `pnpm db:deploy` 로 1팀 3개 + 3팀 1개를 올렸다(재영 확인). `_model.MIGRATION_APPLIED = True` — 3팀 DDL 마이그레이션은 이제 고치지 않는다.
* **Deprecation**: [Items API](/api/items-api.md) — 템플릿 견본(items · stock_movements · staff/customers 로그인 · `user:create` ·
  견본 마이그레이션 3개)을 지웠다(재영, (a) 방식). [Authentication](/api/auth.md) 은 남은 틀(가드 · 비밀값 · 요청 제한 · scrypt)과
  새 로그인이 지켜야 할 토큰 규칙으로 다시 썼고, `UserType` 은 `admin` · `account` 자리가 됐다. [Whale ERP API](/api/whale-erp-api.md) ·
  [Testing](/conventions/testing.md) · [Naming](/conventions/naming.md) 해설 · index 의 견본 언급을 정리했다. 원자료 표의 견본 예시는 원자료 고침을 기다린다.
* **Update**: [Team 3 physical schema](/domain/team3-physical-schema.md) — 3팀 DDL 마이그레이션 `20261007000000_team3_initial` 을
  생성기가 schema.sql 과 같은 본문으로 쓴다. 적용한 뒤에는 `_model.MIGRATION_APPLIED` 로 덮어쓰기를 막는다. 아직 어느 DB 에도 적용 전.
* **Update**: 1팀 enum 8개에 `@@map` 을 달았다(3팀 수정, 재영 승인, 1팀 전달 사항 16). [Team 3 physical schema](/domain/team3-physical-schema.md)
  — 실패하던 쿼리가 통과하고 `prisma migrate diff` 에는 일부러 SQL 에만 둔 29건만 남는다.
* **Update**: 원자료(cc9f5f5)를 [Naming conventions](/conventions/naming.md) 에 옮겼다 — 「고객지원 · 알림」에서 알림 유형 · 발송 용도
  코드값 표가 빠지고 템플릿 이름 · 수신 설정 묶음 · 기본 템플릿 코드 표가 들어왔다. 「사람 · 조직」 · 「급여」도 원자료대로 맞췄다.
* **Update**: 공통코드 `NOTIFICATION_TYPE` · `SEND_PURPOSE` 를 없앴다(재영). [Team 3 physical schema](/domain/team3-physical-schema.md) —
  템플릿은 채널 + 이름 + 코드, 알림 기록 · 메일 로그는 템플릿 코드를 담는다, 직원 수신 설정은 `preference_category` 4종(근로계약서 ·
  급여명세서는 끌 수 없음 CHECK). [Kakao Alimtalk](/api/alimtalk.md) 한 줄 고침.
* **Update**: 원자료(52c5d66 이후)의 「근무 · 출퇴근」 · 「급여」 · 「고객지원 · 알림」을 [Naming conventions](/conventions/naming.md) 에
  그대로 옮겼다 — 근무 유형 4종(DAY 추가), 급여 항목 전용 표 `payslip_item_master` · 구분 4종 · 항목 코드 29, 노출 대상 `service_code`.
* **Update**: [Team 3 physical schema](/domain/team3-physical-schema.md) — 3팀 공통코드 확정(재영)에 따라 급여 항목 전용 표
  `payslip_item_masters`(29개, 명세서 줄은 FK + 이름 · 구분 · 비과세 사본), 노출 대상 `service_code`, `work_type` 에 DAY. 41개.
  모든 마이그레이션 SQL 로 만든 DB 를 schema.prisma 와 비교해, `prisma migrate dev` 가 3팀→1팀 외래키 28개를 지우고 1팀 열한 칸을
  지웠다 다시 만들려 한다는 것(1팀 enum 8개에 `@@map` 없음)과, 그 때문에 1팀 enum 칸으로 거르는 쿼리가 실제로 실패한다는 것을 적었다.
* **Update**: 원자료(76fe6ff, md5 81391575)의 5장 「고객지원 · 알림」을 [Naming conventions](/conventions/naming.md) 에
  반영했다 — 알림 템플릿 · 발송 채널 · 템플릿 코드(운영자가 고칠 수 있음) · 사용 여부 · 변수 목록, 공통코드
  `NOTIFICATION_TYPE` 14 · `SEND_PURPOSE` 13 코드값 표. 원자료에 같은 블록의 옛 판(「시스템이 만들고 바꾸지 않는다」)이
  한 벌 더 남아 있어 앞쪽 새 판만 옮겼고, 기획 세션이 옛 판을 지웠다(e3e8141, md5 547c309e — okf 와 표 줄 차이 0). 삭제 표시 · CHECK 제약 · total 구하기 · 계정 줄을 원자료 문구로 맞췄다.
* **Update**: 알림 템플릿 재영 결정 다섯 — 변수 목록을 JSON 칸 하나로(변수 테이블 없앰, DB 는 배열 CHECK 만), 꺼진 템플릿도
  칸을 차지, 발송 실패(필수 변수 · 사용 안 함 · 코드 없음)는 로그 후 throw, 템플릿 코드는 모두 수정 가능(운영 정책 NTF-24),
  notify(유형) 없음. [Team 3 physical schema](/domain/team3-physical-schema.md) 40개, [Kakao Alimtalk](/api/alimtalk.md) 반영.
* **Update**: 알림 템플릿 등록과 전 항목 수정(재영). [Team 3 physical schema](/domain/team3-physical-schema.md) — 41개,
  `notification_template_variables`(is_deleted · 부분 고유), `is_active`, 이력은 변경 전 행 전체, `template_code` 는 형식
  CHECK 만(유도식 CHECK 뺌). [Kakao Alimtalk](/api/alimtalk.md) — 변수 컴파일 검사가 없어지고 발송 때 검사로 옮겨 간다,
  꺼진 템플릿·바뀐 템플릿 코드가 발송 때 처음 드러난다. 물리 생성기 자체 검사에 「한 테이블 안 같은 칸 두 번」을 더했다.
* **Update**: [Team 3 physical schema](/domain/team3-physical-schema.md) — `notification_templates.template_code`(재영).
  형식 CHECK 대신 「채널 접두 + _ + 유형·용도 코드」와 같다는 CHECK 하나로 형식 · 접두 짝 · 불변을 함께 보장한다고 적었다.
* **Update**: [Team 3 physical schema](/domain/team3-physical-schema.md) — 1팀 메일 8종도 알림 템플릿이 맡는다(재영 A안).
  1팀이 `MAIL_TYPE` 을 뺐고(9b08053), 공통코드 `SEND_PURPOSE` 가 1팀 코드값 그대로 8개를 더해 13개, 기본 템플릿은 37건이
  됐다. 스키마는 바뀌지 않는다.
* **Update**: [Team 3 physical schema](/domain/team3-physical-schema.md) 출처 시각만 옮겼다 — front 논리 ERD(95efc9f)의
  `notification_templates.body` 설명이 B안 문구로 바뀌어 정의서 · schema.sql · schema.prisma 를 다시 생성했다.
* **Update**: 알림톡 문구의 운영 원본을 `notification_templates` 로 옮기기로 했다(재영 B안, 결정만 · 코드 미구현).
  [Kakao Alimtalk](/api/alimtalk.md) 의 「Templates are code」를 「초기 문구는 코드, 운영 원본은 표」로 고쳤고, 본문이
  DB 에서 오면 변수 타입을 본문 리터럴이 아니라 코드의 변수 목록에서 뽑아야 한다는 점을 적었다.
  [Team 3 physical schema](/domain/team3-physical-schema.md) 에 기본 템플릿 29건을 마이그레이션 INSERT 로 넣는다고 적었다.
* **Update**: [Team 1 physical schema](/domain/team1-physical-schema.md) — 공통코드 `MAIL_TYPE`
  그룹과 상세 8개를 초기 데이터에서 뺐다(재영). 메일 유형은 메일 템플릿을 따로 관리해 그 정보를
  쓴다. 아직 어느 DB 에도 적용 전이라 `20261006000100_team1_initial_data` 를 직접 고쳤다 — 공통코드는
  그룹 12 · 상세 52, 기준 데이터는 245행이 되고 뒤 그룹의 표시 순서는 한 칸씩 당겼다.
  `mail_send_logs.mail_type_code` 컬럼은 남기고(외래키 없음) 그 주석은 템플릿 테이블이 생길 때
  고친다. [Naming conventions](/conventions/naming.md) 대응표의 「공통코드 `MAIL_TYPE` 8종」은
  원자료를 고쳐야 하는 항목이라 손대지 않았다.
* **Creation**: `whale-erp-new-front` 의 `docs/erd/team1/schema.sql` 과 `docs/seed/initial-data-request.md`
  에서 [Team 1 physical schema](/domain/team1-physical-schema.md) 를 만들었다. 1팀 27 테이블을
  `prisma/schema.prisma` 에 넣고 DDL 마이그레이션 `20261006000000_team1_initial` 을 썼다 — 3팀이
  기다리던 전제다. Prisma 가 옮기지 못하는 제약 37개(CHECK 32 · 부분 고유 5)와, 그 부분 고유가
  담고 있는 업무 규칙(플랫폼 BP 한 행, 탈퇴 제외 중복 검사, `login_id` 는 탈퇴 포함 고유,
  `NULLS NOT DISTINCT` 권한명)을 적었다. 3팀과의 경계는 양쪽 다 정수 컬럼으로 그대로 뒀다.
* **Update**: 같은 concept 에 초기 데이터를 적었다. 시드 스크립트 없이 전부 마이그레이션 INSERT 다
  (재영) — 기준 데이터 245행(플랫폼 BP · 공통코드 12+52 · 메뉴 64 · 권한 그룹 3 · 메뉴 권한 106 ·
  플랫폼 마스터 · 약관 버전 6)은 `20261006000100_team1_initial_data`, 공식 휴일 1346행은
  `20261006000200_team1_public_holidays`. `_prisma_migrations` 가 한 번만 실행되는 것을 보장해
  멱등 로직이 없고 설치가 `pnpm db:deploy` 하나다. IDENTITY 기본키 때문에 자식 행은 코드값으로
  조인하고, 각 파일 끝의 `DO` 블록이 건수와 정합성(약관 유형의 공통코드 존재, 실제 달력 표본)을
  검사한다. 플랫폼 마스터는 쓸 수 있는 비밀번호 없이(`password_hash = '!'`) 넣고 첫 로그인을 임시
  비밀번호 발급으로 돌린다 — 마이그레이션에 비밀이 없고, 계정의 보안은 등록 이메일 수신함의
  보안과 같다. 공휴일은 계산 결과를 펼친 것이고 계산기는 일회용이라 저장소에 두지 않았다 — 대신
  규칙 전체를 그 마이그레이션 머리말에 적었다. 음력은 한국천문연구원 변환 표 상한 때문에 2050년
  까지만 들어 있다. 여섯 마이그레이션 전부 PGlite(PG 18)에 적용해 제약 동작과 적재 결과를
  확인했다.
* **Update**: [Team 3 physical schema](/domain/team3-physical-schema.md) — 알림 템플릿 두 테이블(재영 결정, 기획 세션
  전달)로 40개가 됐다. 알림톡 행에는 본문을 두지 않는 CHECK 를 적었다(제안). `_build_prisma.py` 가 표시 줄 아래를
  끝까지 다시 써서 뒤에 붙은 1팀 구역을 지우던 경계 함정, 63바이트를 넘는 이름이 오류 없이 잘리는 함정과 그것을 막는
  자체 검사를 적었다. 1팀 마이그레이션이 들어와 3팀 마이그레이션을 막던 이유가 사라졌다는 점도 고쳤다.
* **Update**: 같은 날 재영 결정으로 알림톡 행에도 본문을 둔다(네 채널 모두 필수). 알림톡 본문은 화면용 사본이고
  보내는 문구는 `ALIMTALK_TEMPLATES` 라는 점, 제목은 알림톡만 비운다는 CHECK 를 적었다.
* **Update**: 같은 날 재영 결정으로 알림톡 승인 상태·반려 사유와 enum `alimtalk_approval_status` 를 없앴다. 문구는
  카카오 검수 뒤 코드로 고치고, 검수 안 된 문구는 비즈뿌리오가 거절해 발송 기록에 남는다.

## 2026-10-06
* **Creation**: [Kakao Alimtalk (Bizppurio)](/api/alimtalk.md) 를 추가했다. 각 도메인이 쓰는 공통
  `AlimtalkService`, 본문에서 변수 타입을 뽑는 템플릿 레지스트리, 토큰을 캐시하는 비즈뿌리오 클라이언트다.
  발송 접수까지만 하고 결과 폴링·발송 이력 테이블·SMS 대체발송은 없다. 템플릿 본문은 아직 비어 있다.
* **Update**: [Employment Contract Batch](/api/employment-contract-batch.md) 에 구현된 부분을 적었다.
  공통 헬퍼 `BatchLockService` 와 잡 이름 상수 `BATCH_JOB`, 예제인 계약 만료 배치(`ContractsModule`)가
  생겼다. 만료 배치는 `contracts` 마이그레이션 전이라 `AppModule` 에 넣지 않았다. 실행 기록은 테이블
  대신 Logger 에 남긴다. `@nestjs/schedule` 은 12.x 가 ESM 전용이라 6.x 로 고정했다.
  락은 동시 실행만 막고 사이클당 1회는 보장하지 않는다는 점(설계 요구사항 1 불성립)을 적었다.
  [Whale ERP API](/api/whale-erp-api.md) 의 `AppModule` 구성에 `ScheduleModule` 을 더했다.
* **Update**: [Whale ERP API](/api/whale-erp-api.md) — `EnumsModule`(`GET /enums`, 공개), Swagger 문서를
  `src/openapi/document.ts` 한 곳에서 만든다는 것, `pnpm openapi:export` 를 적었다. main.ts·package.json 이 바뀌어
  [Items API](/api/items-api.md)·[Testing](/conventions/testing.md) 의 출처 시각도 옮겼다(내용 변화 없음).
* **Update**: 원자료(md5 f7ff246d)의 「API 타입·enum 공유」를 [Naming conventions](/conventions/naming.md) 에
  반영했다. enum 값·한글은 front·staff 가 `GET /enums` 로 조회하고(같은 날 생성 파일 방식에서 바꿈), openapi.json 은
  요청·응답 모양에만 쓴다. 「화면 문구」 줄은 `getEnum` 의 label 을 쓰는 것으로 바뀌었다. 값에 따라 갈리는 코드는
  여전히 값을 적는다는 점을 덧붙였다.
* **Update**: 원자료(md5 59625752 — 원본을 커밋된 `openapi/openapi.json` 으로 맞춘 판)의 「API 타입·enum 공유」 확정분을 [Naming conventions](/conventions/naming.md)
  에 반영했다 — 생성 도구 openapi-typescript, api 가 문서·한글 대응표 파일을 커밋하고 front·staff 가
  `WHALE_API_DIR` 로 읽어 생성, 생성 파일에 api 커밋 해시. 1팀 동의 전까지 3팀 코드에만 쓴다.
* **Update**: `2026-09-30-네이밍-규칙.md`(md5 ebb46852)의 「API 타입·enum 공유」(A안, 재영)를
  [Naming conventions](/conventions/naming.md) 에 반영했다. api `/docs-json` 이 원본이고 front·staff 는 생성해
  커밋한다. enum 필드에만 `@ApiProperty({ enum, enumName })` 를 다는 이유(플러그인의 `@IsIn` enum 은 이름이
  없다)와, enumName 을 한글 대응표 이름과 맞춰야 한다는 점, `PayslipReviewReasonValue` 같은 이름 함정을 적었다.
* **Update**: [Team 3 physical schema](/domain/team3-physical-schema.md) 에 Prisma 쪽을 적었다. 3팀 38개
  모델이 `prisma/schema.prisma` 에 들어갔고(견본 4개는 그대로), 마이그레이션은 1팀 테이블이 생길 때까지
  만들지 않는다(재영 1A·2B·3A). 1팀 테이블은 모델이 아니라 정수 컬럼, Prisma 로 옮기지 못한 제약 53개,
  enum 이름 충돌 하나, IDENTITY 표기 차이를 적었다.
* **Creation**: Added the [Employment Contract Batch (Expiry & Reminder)](/api/employment-contract-batch.md) design concept — advisory-lock based duplicate-execution guard for the contract auto-expiry and reminder batches, summarizing `docs/batch/employment-contract-batch.md`. Not yet implemented.
* **Creation**: `2026-10-06-3팀-물리-ERD.md` · `2026-10-06-3팀-schema.sql` 에서 [Team 3 physical schema](/domain/team3-physical-schema.md)
  를 만들었다(재영 승인). 1팀 스키마 위에 얹는다는 점, Prisma 가 옮기지 못하는 CHECK·부분 고유·겹침 금지,
  논리 ERD 와 달리 물리에서 정한 것(발행 문서 스냅숏, is_deleted 범위, integer 금액, 추가 컬럼)을 적었다.
  `domain/` 아래 첫 concept 이다.
* **Update**: `2026-09-30-네이밍-규칙.md`(md5 d203fb0d, 세 저장소 동일)의 1팀 변경 둘을
  [Naming conventions](/conventions/naming.md) 에 반영했다. 「사람 · 조직」 역할 값을
  `PLATFORM_MASTER` 류에서 공통코드 `ROLE_TYPE` 상세코드(`PM`·`PA`·`BM`·`BA`·`FM`·`FA`)로 바꿨다 —
  긴 형식은 세 저장소 어디에서도 쓰이는 곳이 없었고, 1팀 물리 모델의 `role_groups.role_code`
  CHECK 제약(`^[A-Z]{2}[0-9]{6}$`)이 유형코드를 대문자 2글자로 못 박아 접두로 쓸 수도 없다.
  약관 유형 상세코드 `STAFF_PRIVACY_COLLECT` 는 21자라 `code_items.item_code` 의 20자 제약을
  넘겨 `STAFF_PRIVACY`(13자)로 줄였다. 이 저장소 코드에는 영향이 없다 — 두 값 모두 아직
  스키마에 없고, `staff`·`customers` 는 네이밍 규칙이 예제·템플릿으로 남겨 둔 테이블이다.
* **Update**: `2026-09-30-네이밍-규칙.md`(md5 8f295c76, 세 저장소 동일)를 [Naming conventions](/conventions/naming.md)
  에 반영했다. 재영 결정(고침 2026-10-06): 역할 외래키 `{역할}_by` — 「Primary keys are named
  after the table」 의 "외래키는 기본키와 같은 이름" 예외로도 적었다 —, 대응표에 직무 `job_title`,
  임금계약서 `wage_contract`, 계약서 파일 구분 4종, 4대보험 가입 여부 두 칸. 같은 원자료에 1팀
  변경이 함께 들어와 반영했다: 약어 예외 `admin`, `auth_type_code`→`role_type_code`, 약관 유형 6종,
  BP 기본키 `bp_id`→`bp_code_id`, `repeat_until`→`repeat_end_date`, `effective_from`→
  `effective_start_date`, `public_holiday_sync_log`→`public_holiday_synchronization_log`. 이 1팀
  변경은 원자료 「고침: 2026-10-02 — (1팀, 커밋 f300ef3·c1a05da) …」 줄에 기록돼 있다(처음에
  빠져 있다가 2026-10-06 재영 지시로 추가됨, md5 c87a7dad).

## 2026-10-02
* **Update**: 원자료 「고침: 2026-10-02 — 6장 바꾸는 방법을 실제 운영에 맞춤」을 받았다.
  [Naming conventions](/conventions/naming.md) 의 「Changing it」 이 이미 같은 내용이라 concept 은
  고치지 않았다(`verified` 유지).
* **Update**: [Naming conventions](/conventions/naming.md) 의 「Changing it」 을 실제 운영에 맞췄다.
  원자료는 날짜 붙은 새 파일이 아니라 한 파일을 제자리에서 고친다. 이어서 재영이 10-01 이후
  변경분(삭제 표시 · 기본키 · 1팀 추가분 · 10-02 결정 두 건 · 이 수정)을 검토해 `verified` 를
  올렸다. `generated.at` 과 같은 시각이라 검토 후 변경 신호는 꺼져 있다.
* **Update**: [Naming conventions](/conventions/naming.md) — 재영 결정 두 가지(기획 세션 전달).
  1팀 추가분은 1팀이 판단하는 영역이라 재영 확인 대상이 아니라고 Status 절을 고쳤다. 로그인
  토큰 수명(1팀 관리자 1시간·1시간, api 15분·7일, 직원 근무 앱 30일)은 맞출 대상이 아니라고
  인증·계정 절에 적었다.
* **Update**: `2026-09-30-네이밍-규칙.md` 에 1팀이 더한 내용을 [Naming conventions](/conventions/naming.md)
  에 반영했다. 약어 예외 `biz`·`ceo`, 「Identifier exceptions (1팀)」 절, 인증·계정 · BP·점포 ·
  설정·시스템관리 대응표. `customers` → `admin_accounts` 개명을 「Where this repository already
  disagrees」 에 넣었다(코드와 로그인 경로는 아직 `customers`). `admin_session` 수명(1시간·1시간)이
  api 의 실제 발급값(15분·7일)과 다르다는 점과, 원자료 상태 줄에 1팀 추가분의 재영 확인이 없다는
  점을 함께 적었다.
* **Update**: `2026-09-30-네이밍-규칙.md` 의 기본키 규칙을 [Naming conventions](/conventions/naming.md)
  에 반영했다. 기본키도 `{참조 단수}_id` 로 짓고(`contracts.contract_id`) 새 테이블부터
  적용한다. 「Where this repository already disagrees」 에 기본키 줄을 넣으면서, 지금 있는
  4개 테이블은 예제·템플릿 인증 주체라 결함이 아니며 계정 테이블·첫 도메인 모듈과 함께
  정리된다는 이유를 적었다.
* **Update**: [Naming conventions](/conventions/naming.md) 의 DB 절에 삭제 표시 규칙을
  넣었다(재영 지시). `is_deleted boolean NOT NULL DEFAULT false` 하나로 표시하고, 시각 예시의
  `deleted_at` 은 뺐다. 삭제가 가능한 테이블에만 두며 `stock_movements` 와 `*_logs`·`*_histories`
  에는 두지 않는다. 조회마다 `is_deleted = false` 를 걸어야 하고, 유니크 제약은 부분 인덱스로
  바꿔야 한다는 두 함정을 함께 적었다. 원자료에는 아직 없다 — 기획 세션에 반영을 요청했다.

## 2026-10-01
* **Update**: [Naming conventions](/conventions/naming.md) 에 `verified` 를 넣었다.
  재영이 1~5장 전체를 확인한 사실이 본문 Status 절에만 있어, 내용이 나중에 바뀌어도
  그 문장이 그대로 남아 거짓이 되는 상태였다. 번들의 첫 `verified` 항목이다.
  `generated.at` 은 올리지 않았다 — 본문이 바뀐 것이 아니므로 올리면
  `verified.at < generated.at` 이 되어 방금 기록한 검토가 그 자리에서 무효가 된다.
* **Update**: [Naming](/conventions/naming.md) 문서 전체(1~5장)를 2026-10-01 재영 확인으로 확정했다.
* **Update**: [Naming](/conventions/naming.md) 의 영문 식별자 대응표를 2026-10-01 재영 확인으로 표시했다. 1~4장 계층별 규칙은 여전히 제안이다.
* **Update**: `2026-09-30-네이밍-규칙.md` 가 바뀌어 [Naming conventions](/conventions/naming.md)
  에 반영했다. 「API 목록 응답」 절이 새로 생겼고(`{ items, total }`, `findMany`+`count` 를
  `$transaction` 으로, `page`·`pageSize` 기본 20, 정렬 끝에 `id`), 오류 응답은 Nest 기본을
  유지하는 쪽으로 바뀌어 「Where this repository already disagrees」 의 오류 형식 줄을 지웠다.
  날짜·시각 형식 규칙은 원자료에서 빠졌다. 문서 상태를 `draft` 로 내렸다 — 원자료가 전체를
  「기획 세션 제안 · 재영 검토 전」으로 표시하고 목록 응답만 재영 확인이다.

## 2026-09-30
* **Update**: [Naming conventions](/conventions/naming.md) — `items` 를 규칙에 맞추지
  않기로 한 결정을 적었다. 예제일 뿐이고 맞추려면 `whale-erp-front` 를 같이 고쳐야 한다.
  첫 실제 도메인 모듈을 규칙대로 만들어 새 본보기로 삼는다. `okf/index.md` 가 아직
  [Items API](/api/items-api.md) 를 복사 대상으로 가리키는 점도 함께 남겼다.
* **Update**: [Naming conventions](/conventions/naming.md) — `/items` 에 부르는 쪽이
  없다고 적은 것을 고쳤다. `whale-erp-front` 의 `listItems`(`src/lib/api.ts:145`)가
  `/items?take=` 로 부르고 응답을 `Item[]` 로 읽는다. 파라미터를 빼면 전역
  `ValidationPipe` 의 `forbidNonWhitelisted` 때문에 400 이 되므로, 이 저장소만으로는
  규칙에 맞출 수 없다.
* **Creation**: `2026-09-30-네이밍-규칙.md` 의 DB·API·FRONT 규칙과 용어집 영문 식별자
  대응표를 [Naming conventions](/conventions/naming.md) 로 새로 만들었다. 규칙과 현재
  코드가 어긋나는 네 곳(목록 응답 모양, 페이지 파라미터, 오류 형식, `staff` 테이블의
  정체)을 같은 문서에 적었다 — `items` 가 worked example 이라 그대로 복사하면
  불일치가 번진다.

## 2026-08-31
* **Update**: [Testing conventions](/conventions/testing.md) — the single-case example no longer shows the `pnpm test -- -t` form that CLAUDE.md forbids, and the concept now says which tests belong in e2e.
* **Update**: [Whale ERP API](/api/whale-erp-api.md) — the frontmatter description called the service a skeleton with no domain code, contradicting its own body.
* **Update**: [Authentication](/api/auth.md) — losing the rotation race now revokes the session too, the signing key is length-checked at startup, the login routes are rate limited on IP and account axes, and `user:create` no longer takes the password as an argument.
* **Update**: [Authentication](/api/auth.md) — refresh reuse now revokes the whole session, rotation became a single conditional write, login runs the password comparison even for unknown accounts, and scrypt parameters are stored in the hash.
* **Update**: [Items API](/api/items-api.md) — the item routes are staff-token-only (`@UserTypes('staff')`); a customer token gets 403.

## 2026-08-28
* **Creation**: Added the [Authentication](/api/auth.md) concept: staff/customer tables, the deny-by-default global guard, and rotating refresh tokens.
* **Update**: [Whale ERP API](/api/whale-erp-api.md) no longer describes the service as unauthenticated; every route now needs a bearer token unless marked `@Public()`.
* **Update**: Added update and delete endpoints to [Items API](/api/items-api.md); deletion is restricted by the movement foreign key rather than cascading.
* **Update**: Narrowed id columns from bigint to integer; responses now carry numeric ids ([Items API](/api/items-api.md)).
* **Update**: Default listen port moved from 3000 to 8000 in [Whale ERP API](/api/whale-erp-api.md).
* **Update**: Noted the Swagger endpoints and their production cut-off on [Items API](/api/items-api.md).
* **Creation**: Added the [Items API](/api/items-api.md) concept covering derived stock, the row lock, and the two-layer constraints.
* **Update**: Recorded the ConfigModule wiring and the APP_ENV profile scheme in [Whale ERP API](/api/whale-erp-api.md); the service is no longer config-less.
* **Update**: Recorded the test-first policy for API code in [testing conventions](/conventions/testing.md); the directive itself lives in CLAUDE.md.
* **Initialization**: Established the bundle root, targeting OKF v0.2.
* **Creation**: Added the [Whale ERP API](/api/whale-erp-api.md) service concept.
* **Creation**: Added [testing](/conventions/testing.md) and [TypeScript/lint](/conventions/typescript.md) convention concepts.
