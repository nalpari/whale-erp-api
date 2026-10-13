# 운영 알림 API 계획

**목표:** 운영 알림을 만드는 공통 함수와 관리자 웹 운영 알림함이 쓰는 조회·읽음·삭제 API를 만든다.
업무 흐름(배치·계약·문의 처리)은 건드리지 않는다. 사건이 나면 각 업무 일감이 공통 함수를 부른다(2026-10-13 재영).

**Plane 일감 (운영 알림 묶음 #244·#245 아래만):** #246 데이터 구조 · #247 공통 생성 함수 · #248 수신 대상 결정 · #250 수신 권한 점검 · #251 목록과 미확인 건수 · #252 읽음 처리와 모두 읽음. 화면 #253·#254·#255 는 front 계획. #249 이메일은 효준.

**짝 문서:** front `docs/plans/2026-10-13-ops-notifications-screen.md`

**작업 위치:** 워크트리 `~/.whale-erp-worktrees/whale-erp-api/petra`, 브랜치 `snorlax`(origin/main `4613a7d`에서 시작)

## 근거

| 근거 | 쓰는 곳 |
|---|---|
| 운영 정책 NTF-01 | 유형 열 가지와 템플릿 코드 열 개를 그대로 쓴다. 알림마다 만들 때 쓴 템플릿 코드를 남긴다 |
| 운영 정책 NTF-02 | 웹 운영 알림함만 쓴다. 푸시와 문자는 없다 |
| 운영 정책 NTF-03 | 이메일을 같이 보내는 유형이 있다. 메일은 WHALEERP-249(효준)가 붙인다. 이 PR은 붙일 자리만 둔다 |
| 운영 정책 NTF-04 | 수신자 판정 |
| 운영 정책 NTF-05 | `dedupe_key` 로 중복을 막고 읽음은 `notification_recipients` 행마다 따로 둔다 |
| 운영 정책 NTF-06 | 상세로 가면 읽음이 된다. 한꺼번에 바꾸는 것은 모두 읽음뿐이다 |
| 운영 정책 NTF-07 | 종과 운영 알림함이 같은 목록 API를 쓴다 |
| 운영 정책 NTF-08 | 업무 트랜잭션이 커밋된 뒤에 만들고, 실패해도 던지지 않고 로그만 남긴다 |
| 운영 정책 CNT-10 | 문의사항 접수는 플랫폼 운영자의 운영 알림함에만 간다(이메일 없음) |
| Manyfast 「운영 알림 생성」·「운영 알림함 확인 및 업무 이동」 | 위 규칙과 같다. 「알림 생성 실패 → 실패 사실 기록」, 「수신자가 없으면 만들지 않고 기록」 |
| Manyfast 「알림 템플릿 관리」 | 문구는 `notification_templates` 의 NTF 템플릿을 읽어 알림에 박아 둔다. 템플릿을 나중에 고쳐도 이미 만든 알림은 바뀌지 않는다 |
| 데모 `notify/index.mjs` | 「선택 삭제」(2026-10-02 재영). 받은 사람별 `is_deleted` 로 지운다 |

## 범위

**넣는 것**
1. `NotificationsModule` 안에 생성 서비스(`OpsNotificationService.notify`)와 수신자 판정을 둔다.
2. 운영 알림함 API 네 개를 만든다: 목록, 하나 읽음, 모두 읽음, 선택 삭제.

**넣지 않는 것**
- 업무 흐름 연결 전부. 만료 배치도 포함한다. 사건 자리에서 `notify` 를 부르는 일은 각 업무 일감이 맡는다(#154·#152 민식, #137 민식, #281·#274·#296 창수). 부를 자리와 인자는 「이벤트별 생성 지점」 표와 `okf/api/notifications-api.md` 에 적어 둔다.
- 유형별 생성 함수(`contractSigned(id)` 등). 유형이 늘 때마다 함수가 늘어서 두지 않는다. 공통 함수 하나와 수신자 판정 함수 셋만 내보낸다(2026-10-13 재영).
- 이메일 동시 발송(운영 정책 NTF-03). Plane WHALEERP-249로 효준에게 넘겼다(2026-10-13 재영). 이 PR과 #16 BP 회원가입(`MailModule`·`ADMIN_WEB_URL`)이 main에 들어온 뒤 시작한다. 붙일 자리는 「생성 서비스」의 반환값, 링크 규칙은 「메일 버튼 링크」에 적었다.

## 쟁점 (front 목업 `docs/mockup/notify/overview.html` 에 적음)

| ID | 내용 | 상태 | 처리 |
|---|---|---|---|
| NOTIFY-12 | `notifications` 에 제목 칸이 없다. NTF 템플릿은 제목과 둘째 줄로 되어 있다 | 확정 A (2026-10-13 재영) | `title` 칸을 더했다(`20261013144718_team3_notification_title`) |
| NOTIFY-13 | 가맹 점포 계약의 알림을 BP 마스터·BP 관리자도 받는가 | 확정 B (2026-10-13 재영) | 본사 제공에 동의한 직원이면 BP 마스터·BP 관리자도 받는다. `storeManagers` 가 직원 레코드를 받는다 |
| NOTIFY-14 | 명세에는 운영 알림을 보낸다고 적혀 있는데 템플릿 코드가 없는 경우가 있다. 가입 불가(만 19세 미만), 직원 자료 일괄 저장 완료·실패다 | 확정 B (2026-10-13 재영) | 운영 알림은 열 가지 그대로. 두 사건은 각 화면 상태로 보인다 |
| NOTIFY-15 | 템플릿을 못 읽을 때 운영 정책 NTF-24는 「보내지 않음」, NTF-25는 「기본 문구로 보냄」이라 서로 어긋난다 | 확정 (2026-10-13 재영) | 운영 알림은 못 읽으면(없음·사용 안 함·읽기 실패) 만들지 않고 서버 로그만 |

| NOTIFY-16 | 알림을 눌러 갈 업무 화면을 누가 정하는가 | 확정 B (2026-10-13 재영) | 업무 쪽이 `notify` 의 `link` 로 넘긴다. `notifications.link` 칸(`20261013150113_team3_notification_link`) |

## 데이터

스키마는 이미 있다(`prisma/schema.prisma` 1405~1477행). NOTIFY-12가 A로 정해지기 전에는 마이그레이션을 만들지 않는다.

| 칸 | 운영 알림에서 쓰는 값 |
|---|---|
| `notifications.notification_target` | `ADMIN` |
| `notifications.template_code` | `NTF_*` 열 개 가운데 하나 |
| `notifications.related_type` · `related_id` | `CONTRACT` · `INQUIRY` · `LEAD` · `STAFF_MEMBER` 과 그 ID. 가입 연결 보류·소속 추가 확인 거절은 그 직원 레코드를 가리킨다(직원 상세로 간다). 상수는 `src/notifications/related-type.ts` 한 곳에 둔다 |
| `notifications.body` | 템플릿을 채운 결과. 제목 저장 방식은 NOTIFY-12에 따른다 |
| `notifications.dedupe_key` | 사건 하나에 하나: `{템플릿 코드}:{사건 ID}`. 사건 ID는 같은 대상에서 되풀이될 수 있는 사건을 가른다(아래 표) |
| `notification_recipients.admin_account_id` | 받는 관리자. 알림 1 : 받는 사람 N |

사건 하나에 `notifications` 한 행과 받는 사람마다 `notification_recipients` 한 행을 만든다. 부분 유일 인덱스 `notifications_dedupe_key_key` 가 같은 사건을 두 번 만들지 않게 막는다. 충돌(P2002)은 이미 만든 것으로 보고 넘어간다.

**마이그레이션 (NOTIFY-12가 A일 때만)**
- 이름은 `TZ=Asia/Seoul date +%Y%m%d%H%M%S` + `_team3_notification_title` 이다. `ALTER TABLE notifications ADD COLUMN title text NOT NULL` 을 쓰는데, 아직 행이 없어서 기본값은 두지 않는다.
- 3팀 구간은 `docs/erd-physical/_build_prisma.py` 로 만들기 때문에 ERD 원본도 같이 고친다.
- 공용 DB에는 main에 머지한 뒤에 올린다.

## 생성 서비스

```ts
// src/notifications/ops-notification.service.ts
notify(input: {
  templateCode: OpsTemplateCode;            // NTF_* 열 개
  variables: Record<string, string>;        // 템플릿 변수 이름 그대로
  related: { type: RelatedType; id: number };
  eventKey: string;                         // dedupe_key 의 사건 부분
  recipients: number[];                     // admin_account_id, 수신자 판정 함수가 만든다
}): Promise<{
  notificationId: number;
  recipients: { notificationRecipientId: number; adminAccountId: number }[];
} | null>                                   // 던지지 않는다 (운영 정책 NTF-08). 만들지 않았으면 null
```

1. `recipients` 가 비면 만들지 않는다. `warn` 로그에 템플릿 코드와 사건 키를 남긴다(Manyfast 「수신자가 없으면 기록」).
2. `findSendableTemplate(prisma, code, 'NOTIFICATION')` 와 `renderTemplate` 을 그대로 쓴다. 새 렌더러는 만들지 않는다.
3. `$transaction` 안에서 `notification.create` 뒤에 `notificationRecipient.createManyAndReturn` 으로 받는 사람 행을 만든다. 돌려준 수신 행은 메일 발송(WHALEERP-249)이 받는 사람마다 한 통씩 보내고 `notification_deliveries` 를 남기는 데 쓴다.
4. 모든 오류를 잡아 `error` 로그를 남긴다. 로그에는 템플릿 코드, 사건 키, 오류 메시지만 쓰고 변수 값(직원 이름 등)은 쓰지 않는다. P2002는 `debug` 로 남기고 넘어간다.
5. 부르는 쪽은 **업무 트랜잭션이 커밋된 뒤에** 부른다. 트랜잭션 안에서 부르면 알림이 실패할 때 업무까지 롤백된다.

### 메일 버튼 링크 (2026-10-13 재영)

메일의 버튼 링크(`링크` 변수)는 업무 화면 주소가 아니라 `ADMIN_WEB_URL + /notifications/{수신 ID}/open` 이다. 알림함에서 누를 때와 같은 길로 읽음 처리를 거쳐, 알림을 만든 업무 쪽이 넘긴 `link` 로 간다(NOTIFY-16).

### 수신자 판정 (운영 정책 NTF-04)

`src/notifications/recipients.ts` — Prisma 조회 함수 셋. 모두 `isDeleted: false`, `accountStatusCode: 'ACTIVE'` 인 관리자만 고른다.

| 함수 | 대상 | 쓰는 유형 |
|---|---|---|
| `platformOperators()` | `roleTypeCode in (PM, PA)` | 문의사항 접수, 도입문의 접수, 도입문의 처리 상태 변경 |
| `storeManagers(storeId)` | 점포가 속한 BP의 BM·BA·FM·FA 가운데 `isAllStores` 이거나 `storeMappings` 에 그 점포가 있는 관리자. 점포가 가맹이면 BM·BA는 뺀다(NOTIFY-13 후보 A, 정해지면 이 한 곳만 고친다) | 근로계약 날인·거부·만료, 계약 갱신 예정 |
| `activeAdmin(adminAccountId)` | 그 한 사람이 아직 사용 중이면 `[id]`, 아니면 `[]` | 문의사항 답변(등록한 사람), 가입 연결 보류·소속 추가 확인 거절(초안을 쓴 관리자 = `contracts.created_by`) |

## 이벤트별 생성 지점

| 템플릿 코드 | 부를 자리 | 사건 키 | 수신자 | 부르는 업무 일감 |
|---|---|---|---|---|
| `NTF_CONTRACT_EXPIRED` | 만료 배치 — 커밋된 뒤 | 만료 상태 이력 ID (재발송 뒤 다시 만료될 수 있음) | `storeManagers(contract.storeId)` | #154 |
| `NTF_CONTRACT_RENEWAL_DUE` | 갱신 예정 배치 — 계약 종료일 30일 전 | 계약 ID (계약당 한 번) | `storeManagers` | #152·#154 |
| `NTF_CONTRACT_SIGNED` | 날인 처리 커밋 뒤 | 상태 이력 ID | `storeManagers` | #154 |
| `NTF_CONTRACT_REJECTED` | 거부 처리 커밋 뒤 | 상태 이력 ID | `storeManagers` | #154 |
| `NTF_LINK_HOLD` | 가입 연결 보류 생성 커밋 뒤 | 보류 ID | `activeAdmin(contract.createdBy)` | #137 |
| `NTF_AFFILIATION_REJECTED` | 소속 추가 확인 거절 커밋 뒤 | 초대 ID | `activeAdmin(contract.createdBy)` | 맡은 일감 없음 |
| `NTF_INQUIRY_RECEIVED` | 문의사항 등록 커밋 뒤 | 문의 ID | `platformOperators()` | #281 |
| `NTF_INQUIRY_ANSWERED` | 첫 답변 저장 커밋 뒤. 답변을 고칠 때는 보내지 않는다(운영 정책 CNT-17) | 문의 ID | `activeAdmin(문의 등록자)` | #274 |
| `NTF_LEAD_RECEIVED` | 도입문의 접수 커밋 뒤 | 도입문의 ID | `platformOperators()` | #296 |
| `NTF_LEAD_ANSWERED` | 도입문의 처리 상태 변경 커밋 뒤 | 상태 변경 이력 ID | `platformOperators()` | 맡은 일감 없음 |

## API

모든 경로는 `@UserTypes('admin')` 를 붙인다. 가드는 관리자 계정이 사용 중인지 보지 않으므로 서비스가 `accountStatusCode: 'ACTIVE'` 를 다시 확인하고 사용 중이 아니면 403을 준다. 대상은 늘 `admin_account_id = 나`, `is_deleted = false` 인 행이다.

| 메서드 · 경로 | 요청 | 응답 |
|---|---|---|
| `GET /notifications` | `page`(1부터), `pageSize`(기본 20, 최대 200) | `{ items, total, unreadCount }` |
| `POST /notifications/:id/read` | — | 그 알림 한 줄(`relatedType`·`relatedId` 포함). 이미 읽은 것이어도 200. 읽은 시각은 처음 값을 유지한다 |
| `POST /notifications/read-all` | — | `{ updated }` |
| `DELETE /notifications` | `ids=1,2,3`(쿼리, 최대 200) | 204. 내 것이 아닌 ID는 조용히 빠진다 |

**목록 한 줄 (`OpsNotificationItemDto`)**
`id`(= `notification_recipient_id`), `templateCode`, `kind`(템플릿 이름, 아래 참고), `title`, `body`, `relatedType`, `relatedId`, `isRead`, `createdAt`

- `kind` 는 그 코드로 지금 `notification_templates.template_name` 을 찾아서 넣는다. 템플릿이 없으면 코드를 그대로 넣는다. 화면의 「구분」 칸에 쓴다.
- 정렬은 `createdAt` 내림차순, 같으면 `id` 내림차순이다. `findMany` 와 `count` 두 개를 `unreadCount` 와 함께 한 `$transaction` 에 넣는다.
- 종 팝오버(#253, front `NotificationBell`)도 `GET /notifications?pageSize=5` 를 쓰면 되므로 따로 API를 두지 않는다.
- `:id` 가 `1..2147483647` 밖이면 404, `ids` 에 그런 값이나 빈 칸이 있으면 400이다(`contract-id.pipe.ts` 방식). 남의 알림은 404다.

## 테스트 (먼저 쓴다)

| 파일 | 확인할 것 |
|---|---|
| `recipients.spec.ts` | 사용 안 함·삭제된 관리자 제외 / `isAllStores` 와 매핑 / 다른 BP 제외 / 가맹 점포에서 BM·BA 제외 / PM·PA만 |
| `ops-notification.service.spec.ts` | 템플릿을 채워 알림 1행과 받는 사람 N행, 수신 행을 돌려줌 / 수신자가 없으면 만들지 않음 / P2002는 넘어감 / 템플릿이 꺼졌거나 없거나 DB 오류가 나도 던지지 않음 / 로그에 변수 값이 없음 |
| `notifications.service.spec.ts` | 내 것만 / 지운 것 제외 / `unreadCount` / 읽음 시각 유지 / 모두 읽음은 내 미확인만 / 삭제는 내 것만 |
| `notifications.controller.spec.ts` | 사용 중이 아닌 관리자는 403 / 직원 토큰은 403 |
| `test/notifications.e2e-spec.ts` | 쿼리 형식 오류 400 / 목록 모양 `{ items, total, unreadCount }` / 읽음 뒤 `unreadCount` 감소 |

## 리뷰 초점
- **실패가 업무로 번짐** — `notify` 는 어떤 오류에도 던지지 않아야 한다. 템플릿 꺼짐·없음, 필수 변수 빠짐, DB 오류 모두. → 서비스 테스트 「던지지 않음」
- **같은 사건 두 번** — 같은 템플릿 코드와 사건 키로 두 번 부르면 두 번째는 만들지 않아야 한다. → 서비스 테스트 「P2002는 넘어감」
- **남의 알림** — `:id` 로 다른 관리자의 알림을 읽음 처리하거나 지우지 못해야 한다. → 404, 삭제에서는 조용히 빠짐
- **로그의 개인정보** — 직원 이름이 로그에 남으면 안 된다.

## 할 일 순서
1. `recipients.ts` 테스트 → 구현
2. `OpsNotificationService` 테스트 → 구현, `NotificationsModule` 등록
3. 운영 알림함 서비스·컨트롤러·DTO 테스트 → 구현, e2e
4. `pnpm openapi:export` 로 `openapi/openapi.json` 갱신, `okf/api/notifications-api.md` 작성, `okf/log.md` 한 줄
5. `pnpm lint` · `pnpm test` · `pnpm test:e2e` 의 통과 수 확인
