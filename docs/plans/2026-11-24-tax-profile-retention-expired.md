# 퇴직 근무지 신고 정보 — 보존 기간이 지났음을 알리기 (WHALEERP-772)

2026-11-24. 출처: WHALEERP-765 리뷰 참고 의견(효준 제안으로 따로 일감).

## 문제

`GET /me/memberships/:staffMemberId/tax-profile` 은 `taxProfile: null` 을 두 경우에 준다 — ① 처음부터 넣지 않음 ② 퇴직일로부터 3년(운영 정책 RET-01 · TAX-08)이 지남(파기 배치 `retiree-purge.ts` 가 지웠거나, 배치 전이라도 api #313 이 풀지 않음). 직원 근무 앱은 둘 다 「입력한 신고 정보가 없습니다」로 보여 ②가 「넣은 적 없음」으로 읽힌다.

## 바꾸는 것

- 응답에 `expired: boolean` 을 더한다 — 퇴직일이 파기 배치와 같은 기준(`retiredBefore(now)`)보다 앞이면 true. 신고 정보 행이 남아 있든(배치 전) 이미 지워졌든 같다. 퇴직하지 않은 소속은 false. 지금 `taxProfile` 을 null 로 만드는 판정과 같은 값이다.
- 그 밖의 동작(가림 · `editable` · 저장 409)은 그대로. 마이그레이션 없음.
- 직원 앱 문구는 B안(2026-11-24 재영): 「신고 정보 보관 기간이 지났습니다」 · 「퇴직 후 3년이 지나 이 근무지의 신고 정보를 보관하지 않습니다.」 — `expired` 가 퇴직일로만 정해져 넣은 적 없이 기한이 지난 경우도 들어 「지웠습니다」가 아닌 문구를 골랐다.

## 검증

- `my-memberships.service.spec.ts`: 기한 지난 퇴직 레코드 — 행이 있어도 · 없어도 `expired: true` · `taxProfile: null`, 기한 안 퇴직 · 재직은 false.
- `openapi:export`, okf(my-profile) 갱신.
