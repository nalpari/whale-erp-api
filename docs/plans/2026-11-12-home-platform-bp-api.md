# 플랫폼 계정이 고른 BP 의 로그인 후 홈 — api (WHALEERP-667)

근거: 2026-11-12 재영 결정, 운영 정책 v280 HOM-07. front 는 따로 PR 로 올린다.

## 정한 것

- 대상은 플랫폼 마스터 · 플랫폼 관리자다. 범위 선택기에서 고객 BP 를 골라 웨일ERP 탭에 온 경우에만 BP 마스터와 같은 현황을 준다. BP 를 고르지 않으면 지금처럼 `platform: true` 인 빈 결과다.
- 범위는 고른 BP 의 전체 점포 안에서 업무 범위대로다. 직원 목록 · 근로계약 목록처럼 `getManageableStores(adminAccountId, bp)` 에 탭 BP 를 넘긴다.
- 본사 제공 동의 가림은 하지 않는다. 플랫폼 계정은 모두 센다(ATT-30 플랫폼 기준, 목록과 같다). `hidesPersonalData` · `hqVisibleWhere` 가 본사 역할(BM · BA)만 가리므로 PM · PA 는 고치지 않아도 그렇게 된다.
- 내 문의 카드 · 문의 답변완료 줄도 BP 마스터와 똑같이 보인다. 내 문의는 지금처럼 로그인한 계정이 쓴 문의다. 공지 띠는 공지사항 조회 권한이 있으면 보이고, 내용은 공지사항 목록처럼 로그인한 계정의 노출 대상 기준이다(플랫폼 계정은 「회원」 대상 공지) — 홈 api 는 공지를 다루지 않는다.

## 바꾸는 것

홈은 메뉴가 아니라 `@MenuPermission` 가드가 탭 BP 를 정하지 않는다. 그래서 홈이 탭 BP 헤더(`X-Bp-Code-Id`)를 직접 읽는다.

- `HomeController` 의 summary · pending 이 `X-Bp-Code-Id` 헤더를 받아 서비스에 넘긴다.
- `HomeService.contextOf`
  - 플랫폼 계정이 헤더를 보내면 가드(`targetBp`)와 같은 기준으로 BP 를 확인한다. 지우지 않았고 플랫폼 BP 가 아닌 BP 만 받고, 아니면 404 `BP_NOT_FOUND_MESSAGE` 다. 확인한 BP 를 `{ bpCodeId, isPlatformCaller: true }` 로 `getManageableStores` 에 넘긴다.
  - 플랫폼 계정이 헤더를 보내지 않으면 지금처럼 null(`platform: true`)이다.
  - BP · 가맹 계정은 헤더를 보지 않는다. 늘 소속 BP 의 관리 범위다(`scopeAdmin` 도 플랫폼 계정이 아니면 탭 BP 를 쓰지 않는다).

## 검증

- `home.service.spec.ts`: 플랫폼 계정 + 고객 BP 헤더면 그 BP 의 점포로 센다, 헤더 없으면 platform, 없는 · 플랫폼 BP 면 404, BP 계정은 헤더를 무시한다, 플랫폼 계정은 가려지는 점포의 동의하지 않은 직원도 센다.
- 일회용 DB e2e(`test/home.e2e-spec.ts`)에 플랫폼 계정 경우를 더한다.
- 플랫폼 계정이 같은 BP 탭에서 직원 목록 · 근로계약 목록 · TO-DO 목록 · 출퇴근 현황을 열었을 때 홈 숫자와 맞는지 로컬에서 본다.
- lint · tsc · 단위 · e2e, openapi 재생성, okf 갱신.
