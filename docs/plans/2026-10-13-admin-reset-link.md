# 관리자 초기화 재설정 링크 API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 관리자가 직원에게 비밀번호 재설정 링크(24시간 · 한 번)를 보내고, 직원이 그 링크로 지금 비밀번호 없이 새 비밀번호를 정하는 API 세 개를 만든다(WHALEERP-172).

**Architecture:** `src/auth` 에 링크 서비스 · 발송기 자리 · 두 컨트롤러(관리자용 `staff-members/:id/password-reset-links`, 직원용 `auth/account/password-reset-links/*`)를 더한다. 새 비밀번호를 적용하는 공통 함수(`applyNewPassword`)를 뽑아 핀 재설정과 링크 재설정이 같은 규칙(링크 · 핀 모두 닫기 · 세션 끊기 · 잠금 해제 · 이력)을 쓴다. 발송은 핀과 같은 추상 발송기 자리에 Noop 을 꽂는다.

**Tech Stack:** NestJS 11, Prisma 7(PostgreSQL), class-validator, Jest(ts-jest) 단위 · e2e(supertest, 일회용 Postgres).

**Spec:** `docs/plans/2026-10-13-admin-reset-link-design.md`

> **이 계획의 코드 조각은 리뷰 반영 전이다.** 잠금 안 재확인 · 발송 실패 처리 · 테스트 수는 최종 코드와 다르다.
> 최종은 소스와 설계 문서의 「구현 뒤 바뀐 것」 절을 본다.

## Global Constraints

- 작업 위치: `~/.whale-erp-worktrees/whale-erp-api/kyoto`, 브랜치 `charizard`. 명령은 `corepack pnpm …`(시스템 pnpm 은 버전이 달라 실패한다).
- TDD: 테스트를 먼저 쓰고 실패를 **읽고**(오타 · import 실패가 아닌 의도한 이유인지) 구현한다. 결과는 종료 코드가 아니라 passed/failed 개수로 확인한다.
- 단위 테스트는 대상 옆 `src/**/*.spec.ts`(`rootDir` 가 `src`), e2e 는 `test/*.e2e-spec.ts`.
- `pnpm test -- -t "…"` 처럼 `--` 를 넣지 않는다. `corepack pnpm test password-reset-link.service` 처럼 경로 패턴만 준다.
- `pnpm lint` 는 `--fix` 로 파일을 고친다 — diff 를 보기 전에 돌린다.
- e2e 는 일회용 DB 로만: `docker run -d --rm --name whale-e2e-pg -p 55446:5432 -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=e2e postgres:18` → `DATABASE_URL=postgresql://postgres:pw@localhost:55446/e2e corepack pnpm exec prisma migrate deploy` → `DATABASE_URL=… APP_ENV=test JWT_SECRET=<48바이트 base64url> corepack pnpm test:e2e …`. **`pnpm db:deploy` 는 공용 DB 에 붙으므로 쓰지 않는다.**
- 마이그레이션 없음. `password_reset_links`(`token_hash` CHECK `^[0-9a-f]{64}$`, 고유) · `AccountChangeChannel.ADMIN_RESET` · `account_change_histories.requested_by` 는 이미 있다.
- 토큰: `randomBytes(32).toString('base64url')`(43자). 저장은 `hashToken(token)`(sha256 hex, `src/auth/password.ts`). 토큰 · 링크 원문은 DB · 로그 어디에도 남기지 않는다.
- 링크 주소: `new URL('/password-reset/link', STAFF_APP_URL)` + `?token=…`. 운영(`isProduction()`)에서는 https 만, 아니면 기동 때 던진다. 비었으면 기동은 하고 발송만 503.
- 응답 코드(설계 그대로): 관리자 201 `{ issuedAt, expiresAt }` · 404 · 409(가입 전 · 퇴직 · 탈퇴) · 429(같은 계정 1분) · 503. 직원 확인 204/401, 저장 204/400/401.
- 직원 쪽 401 문구 하나: `쓸 수 없는 링크입니다. 관리자에게 다시 청하거나 비밀번호 찾기로 인증번호를 받아 다시 정해 주세요`.
- 코드 주석 · 테스트 이름은 한국어, 저장소 문체(「~다」, 이유를 적는다)를 따른다.
- 커밋은 `/ip-commit-push` 규칙: 영어 type + 한글 제목(50자 이내), 의도 단위, `git add -A` 금지, 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **같은 링크로 저장을 동시에 두 번** — 하나만 204, 다른 하나는 401. 계정 행 잠금 뒤 링크를 다시 읽어야 지켜진다(Task 6 e2e 가 고정).
- **링크가 쓸 수 있는데 비밀번호 규칙 위반** — 400 과 사유, 링크는 그대로라 같은 링크로 다시 성공해야 한다. 닫힌 링크에는 규칙 사유 대신 401(Task 4 단위 · Task 6 e2e).
- **발송 실패 뒤 곧바로 다시 보내기** — 503 뒤 1분 제한(429)에 걸리지 않아야 한다. 실패한 링크 행을 지워서 지킨다(Task 3 단위).
- **핀으로 새 비밀번호를 정한 뒤 남은 관리자 링크** — 닫혀서 401 이어야 한다. 지금 코드는 핀만 닫는다(Task 1 단위 · Task 6 e2e).
- **토큰 원문 노출** — Noop 발송기 로그 · 요청 제한 키 · DB 어디에도 토큰이 없어야 한다(Task 2 · Task 5 단위).

---

## File Structure

| 파일 | 책임 |
|---|---|
| `src/auth/apply-new-password.ts` (새) | 새 비밀번호 적용 공통 함수: 비밀번호 · 잠금 해제 · 링크 · 핀 닫기 · 세션 끊기 · 이력 |
| `src/auth/password-reset.service.ts` (고침) | 핀 저장이 `applyNewPassword` 를 쓴다 |
| `src/auth/password-reset-link-sender.ts` (새) | 발송기 자리(추상 클래스)와 대상 · 내용 타입 |
| `src/auth/noop-password-reset-link.sender.ts` (새) | 아무것도 보내지 않는 발송기(운영에서 쓸 수 없음) |
| `src/auth/staff-app-url.ts` (새) | `STAFF_APP_URL` 읽기 · 검사, 링크 주소 만들기 |
| `src/auth/password-reset-link.service.ts` (새) | 발급 · 확인 · 저장 규칙 |
| `src/auth/password-reset-link.controller.ts` (새) | 직원용 `POST /auth/account/password-reset-links/verify · reset` |
| `src/auth/password-reset-link-admin.controller.ts` (새) | 관리자용 `POST /staff-members/:id/password-reset-links` |
| `src/auth/dto/verify-password-reset-link.dto.ts` · `reset-password-with-link.dto.ts` · `password-reset-link.response.dto.ts` (새) | 요청 · 응답 모양 |
| `src/auth/throttle.ts` (고침) | 계정 축이 본문 `token` 도 센다 |
| `src/auth/auth.module.ts` (고침) | 등록(AdminScopeModule import, 발송기 Noop) |
| `test/password-reset-link.e2e-spec.ts` (새) · `test/account-status-policy.e2e-spec.ts` (고침) | 실제 DB 흐름 · 직원 경로 허용 목록 |
| `okf/api/auth.md` · `okf/log.md` · `CLAUDE.md` · `.env.example` · `openapi/openapi.json` (고침) | 문서 · 설정 키 · API 문서 |

관리자 컨트롤러를 `src/auth` 에 두는 이유: 링크 서비스 · 발송기가 `AuthModule` 에 있고, `StaffMembersModule` 이 `AuthModule` 을 import 하면 전역 가드 · 요청 제한 등록이 얽힌다. 경로(`/staff-members/...`)만 직원 자원 아래다.

---

### Task 1: 새 비밀번호 적용 공통 함수와 핀 저장 연결

**Files:**
- Create: `src/auth/apply-new-password.ts`
- Test: `src/auth/apply-new-password.spec.ts`
- Modify: `src/auth/password-reset.service.ts` (`resetPassword` 의 `apply`)
- Modify: `src/auth/password-reset.service.spec.ts` (tx 목 · 「핀을 소진한다」 단언)

**Interfaces:**
- Produces:
  ```ts
  export interface NewPassword {
    accountId: number;
    passwordHash: string;
    now: Date;
    channel: 'PIN_RESET' | 'ADMIN_RESET';
    /** 관리자 초기화일 때 요청 관리자. 본인 핀이면 없다. */
    requestedBy?: number;
  }
  export function applyNewPassword(
    tx: Prisma.TransactionClient,
    sessions: Pick<AuthSessionService, 'revokeAll'>,
    input: NewPassword,
  ): Promise<void>;
  ```

- [ ] **Step 1: 실패하는 테스트 쓰기** — `src/auth/apply-new-password.spec.ts`

```ts
import { Prisma } from '@prisma/client';
import { applyNewPassword } from './apply-new-password';

describe('applyNewPassword', () => {
  const now = new Date('2026-10-13T03:00:00.000Z');
  let tx: {
    account: { update: jest.Mock };
    passwordResetPin: { updateMany: jest.Mock };
    passwordResetLink: { updateMany: jest.Mock };
    accountChangeHistory: { create: jest.Mock };
  };
  let sessions: { revokeAll: jest.Mock };

  beforeEach(() => {
    tx = {
      account: { update: jest.fn().mockResolvedValue({}) },
      passwordResetPin: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      passwordResetLink: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      accountChangeHistory: { create: jest.fn().mockResolvedValue({}) },
    };
    sessions = { revokeAll: jest.fn().mockResolvedValue(0) };
  });

  const run = (over: Partial<Parameters<typeof applyNewPassword>[2]> = {}) =>
    applyNewPassword(tx as unknown as Prisma.TransactionClient, sessions, {
      accountId: 7,
      passwordHash: 'hash:new',
      now,
      channel: 'PIN_RESET',
      ...over,
    });

  it('비밀번호를 바꾸고 로그인 실패 횟수와 잠금을 지운다', async () => {
    await run();
    expect(tx.account.update).toHaveBeenCalledWith({
      where: { accountId: 7 },
      data: { passwordHash: 'hash:new', failedLoginCount: 0, lockExpiresAt: null },
    });
  });

  it('그 계정의 열린 핀과 열린 링크를 모두 닫는다 — 어느 쪽으로 정했든 남은 길을 막는다', async () => {
    await run();
    expect(tx.passwordResetPin.updateMany).toHaveBeenCalledWith({
      where: { accountId: 7, usedAt: null },
      data: { usedAt: now },
    });
    expect(tx.passwordResetLink.updateMany).toHaveBeenCalledWith({
      where: { accountId: 7, closedAt: null },
      data: { closedAt: now },
    });
  });

  it('모든 기기의 접속을 같은 트랜잭션에서 끊는다', async () => {
    await run();
    expect(sessions.revokeAll).toHaveBeenCalledWith(7, tx);
  });

  it('본인 핀이면 요청 관리자 없이 이력을 남긴다 — 값은 남기지 않는다', async () => {
    await run();
    expect(tx.accountChangeHistory.create).toHaveBeenCalledWith({
      data: { accountId: 7, field: 'PASSWORD', channel: 'PIN_RESET' },
    });
  });

  it('관리자 초기화면 요청 관리자를 이력에 남긴다', async () => {
    await run({ channel: 'ADMIN_RESET', requestedBy: 31 });
    expect(tx.accountChangeHistory.create).toHaveBeenCalledWith({
      data: { accountId: 7, field: 'PASSWORD', channel: 'ADMIN_RESET', requestedBy: 31 },
    });
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `corepack pnpm test apply-new-password`. Expected: FAIL, `Cannot find module './apply-new-password'`.

- [ ] **Step 3: 구현** — `src/auth/apply-new-password.ts`

```ts
import { Prisma } from '@prisma/client';
import type { AuthSessionService } from '../auth-session/auth-session.service';
import { CLEARED_ATTEMPT_STATE } from './attempt-lock';

export interface NewPassword {
  accountId: number;
  passwordHash: string;
  now: Date;
  channel: 'PIN_RESET' | 'ADMIN_RESET';
  /** 관리자 초기화일 때 요청 관리자. 본인 핀이면 없다. */
  requestedBy?: number;
}

/**
 * 새 비밀번호를 적용한다. 본인 핀(WHALEERP-171)과 관리자 링크(WHALEERP-172)가 같은 규칙을 쓰게 한 곳에 둔다.
 * 부르는 쪽의 트랜잭션 안에서 부른다 — 비밀번호만 바뀌고 링크 · 핀 · 다른 기기의 접속이 남는 순간이 없게.
 *
 * 링크 · 핀 어느 쪽으로 정했든 그 계정의 열린 링크와 핀을 모두 닫는다(WHALEERP-172). 하나라도 남으면 이미 바꾼
 * 비밀번호를 그 길로 다시 바꿀 수 있다.
 */
export async function applyNewPassword(
  tx: Prisma.TransactionClient,
  sessions: Pick<AuthSessionService, 'revokeAll'>,
  { accountId, passwordHash, now, channel, requestedBy }: NewPassword,
): Promise<void> {
  await tx.account.update({
    where: { accountId },
    data: {
      passwordHash,
      failedLoginCount: CLEARED_ATTEMPT_STATE.failedCount,
      lockExpiresAt: CLEARED_ATTEMPT_STATE.lockExpiresAt,
    },
  });
  await tx.passwordResetPin.updateMany({
    where: { accountId, usedAt: null },
    data: { usedAt: now },
  });
  await tx.passwordResetLink.updateMany({
    where: { accountId, closedAt: null },
    data: { closedAt: now },
  });
  await sessions.revokeAll(accountId, tx);
  // 값은 남기지 않는다. 누가 어떤 경로로 바꿨는지만 남는다.
  await tx.accountChangeHistory.create({
    data: {
      accountId,
      field: 'PASSWORD',
      channel,
      ...(requestedBy === undefined ? {} : { requestedBy }),
    },
  });
}
```

- [ ] **Step 4: 통과 확인** — Run: `corepack pnpm test apply-new-password`. Expected: `Tests: 5 passed`.

- [ ] **Step 5: 핀 저장 쪽 테스트를 먼저 바꾼다** — `src/auth/password-reset.service.spec.ts`
  - `let tx` 타입과 `beforeEach` 의 `tx` 에 `passwordResetLink: { updateMany: jest.Mock }` 를 더한다:
    ```ts
    passwordResetLink: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    ```
  - `it('핀을 소진한다', …)` 를 아래로 바꾸고 새 테스트를 더한다:
    ```ts
    it('핀을 소진한다 — 그 계정의 열린 핀을 모두 닫는다', async () => {
      await reset();

      expect(tx.passwordResetPin.updateMany).toHaveBeenCalledWith({
        where: { accountId: 7, usedAt: null },
        data: { usedAt: now },
      });
    });

    it('남은 관리자 재설정 링크도 닫는다 — 핀으로 정했는데 링크로 다시 바꿀 수 없게', async () => {
      await reset();

      expect(tx.passwordResetLink.updateMany).toHaveBeenCalledWith({
        where: { accountId: 7, closedAt: null },
        data: { closedAt: now },
      });
    });
    ```
  - Run: `corepack pnpm test password-reset.service`. Expected: 위 두 테스트 FAIL(`passwordResetLink.updateMany` 가 불리지 않음, `updateMany` 단언 불일치).

- [ ] **Step 6: 핀 저장이 공통 함수를 쓰게 한다** — `src/auth/password-reset.service.ts` 의 `resetPassword` 안 `apply` 를 통째로 바꾼다:

```ts
      apply: async (tx, { account, now }, { passwordHash }) => {
        await applyNewPassword(tx, this.sessions, {
          accountId: account.accountId,
          passwordHash,
          now,
          channel: 'PIN_RESET',
        });
      },
```
  - 맨 위 import 에 `import { applyNewPassword } from './apply-new-password';` 를 더하고, 더는 쓰지 않는 `CLEARED_ATTEMPT_STATE` import 를 지운다(남아 있으면 lint 가 경고한다 — 다른 곳에서 쓰면 둔다: `grep -n CLEARED_ATTEMPT_STATE src/auth/password-reset.service.ts`).
  - `MatchedPin` 의 `pinId` 는 다른 곳(틀린 시도 증가)에서 쓰므로 그대로 둔다.

- [ ] **Step 7: 통과 확인** — Run: `corepack pnpm test src/auth`. Expected: 모두 passed. 다른 단언이 `tx.passwordResetPin.update` 의 성공 경로 호출(`usedAt`)을 기대해 깨지면, 그 단언을 Step 5 처럼 `updateMany` 로 바꾼다 — 틀린 시도의 `attemptCount` 증가 단언(`update`)은 그대로다.

- [ ] **Step 8: 커밋**

```bash
git add src/auth/apply-new-password.ts src/auth/apply-new-password.spec.ts src/auth/password-reset.service.ts src/auth/password-reset.service.spec.ts
git commit -m "refactor: 새 비밀번호 적용을 공통 함수로 묶고 핀 저장이 링크도 닫게" -m "핀 · 링크 재설정이 같은 규칙(비밀번호 · 잠금 해제 · 링크 · 핀 닫기 · 세션 · 이력)을 쓰게 applyNewPassword 로 뽑는다. 핀으로 정하면 남은 관리자 링크도 닫는다(WHALEERP-172)." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
  (type 은 동작이 하나 늘었으므로 `feat` 가 맞다고 보면 `feat: 핀으로 비밀번호를 정하면 재설정 링크도 닫기` 로 써도 된다 — 커밋 전에 `/ip-commit-push` 규칙으로 정한다.)

---

### Task 2: 발송기 자리 · Noop 발송기 · 직원 앱 주소

**Files:**
- Create: `src/auth/password-reset-link-sender.ts`
- Create: `src/auth/noop-password-reset-link.sender.ts` · Test: `src/auth/noop-password-reset-link.sender.spec.ts`
- Create: `src/auth/staff-app-url.ts` · Test: `src/auth/staff-app-url.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  // password-reset-link-sender.ts
  export interface PasswordResetLinkTarget { accountId: number; email: string; realName: string }
  export interface PasswordResetLinkMail { storeName: string; link: string; expiresAt: Date; requestedBy: number }
  export abstract class PasswordResetLinkSender {
    abstract isAvailable(): boolean;
    abstract send(target: PasswordResetLinkTarget, mail: PasswordResetLinkMail): Promise<void>;
  }
  // noop-password-reset-link.sender.ts
  export class NoopPasswordResetLinkSender extends PasswordResetLinkSender implements OnModuleInit
  // staff-app-url.ts
  export function readStaffAppUrl(raw: string | undefined, production: boolean): string | null;
  export function resetLinkOf(baseUrl: string, token: string): string;
  ```

- [ ] **Step 1: 실패하는 테스트** — `src/auth/staff-app-url.spec.ts`

```ts
import { readStaffAppUrl, resetLinkOf } from './staff-app-url';

describe('readStaffAppUrl', () => {
  it('비었으면 null — 기동은 하고 링크 발송만 503 이 된다', () => {
    expect(readStaffAppUrl(undefined, false)).toBeNull();
    expect(readStaffAppUrl('  ', true)).toBeNull();
  });

  it('주소를 앞뒤 공백 없이 돌려준다', () => {
    expect(readStaffAppUrl(' http://localhost:3000 ', false)).toBe('http://localhost:3000');
  });

  it('운영에서는 https 만 받는다 — 링크에 토큰이 실린다', () => {
    expect(readStaffAppUrl('https://staff.whale-erp.com', true)).toBe('https://staff.whale-erp.com');
    expect(() => readStaffAppUrl('http://staff.whale-erp.com', true)).toThrow('https');
  });

  it('주소가 아니거나 웹 주소가 아니면 기동 때 던진다', () => {
    expect(() => readStaffAppUrl('staff.whale-erp.com', false)).toThrow();
    expect(() => readStaffAppUrl('whaleerp://reset', false)).toThrow();
  });
});

describe('resetLinkOf', () => {
  it('직원 앱의 재설정 링크 경로에 토큰을 쿼리로 붙인다', () => {
    expect(resetLinkOf('https://staff.whale-erp.com', 'abc_-1')).toBe(
      'https://staff.whale-erp.com/password-reset/link?token=abc_-1',
    );
  });

  it('끝 / 가 있어도 같은 주소다', () => {
    expect(resetLinkOf('https://staff.whale-erp.com/', 'x')).toBe(
      'https://staff.whale-erp.com/password-reset/link?token=x',
    );
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `corepack pnpm test staff-app-url`. Expected: FAIL, `Cannot find module './staff-app-url'`.

- [ ] **Step 3: 구현** — `src/auth/staff-app-url.ts`

```ts
const RESET_LINK_PATH = '/password-reset/link';

/**
 * 직원 앱 주소(`STAFF_APP_URL`). 관리자 초기화 재설정 링크가 이 주소로 간다(WHALEERP-172). 비었으면 null — 기동은
 * 하고 링크 발송만 503 이다(메일 주소 설정 없이도 로그인은 떠야 한다). 잘못된 값은 기동 때 던진다 — 첫 발송 때가
 * 아니라 배포 때 알게. 운영에서는 https 만 받는다: 링크에 비밀번호를 바꿀 권한(토큰)이 실린다.
 *
 * 앱 스킴(`whaleerp://`)은 받지 않는다 — 메일 앱이 막거나 지우고, 앱이 없는 기기에서 스토어로 보낼 수 없다.
 * 앱 포장 때 같은 https 주소를 Universal Links · App Links 로 앱에 연결한다(2026-10-13 노영주).
 */
export function readStaffAppUrl(raw: string | undefined, production: boolean): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (!URL.canParse(value)) throw new Error(`STAFF_APP_URL 이 주소가 아닙니다: ${value}`);
  const { protocol } = new URL(value);
  if (protocol !== 'https:' && protocol !== 'http:')
    throw new Error(`STAFF_APP_URL 은 웹 주소여야 합니다: ${value}`);
  if (production && protocol !== 'https:')
    throw new Error('운영에서 STAFF_APP_URL 은 https 여야 합니다 — 링크에 재설정 토큰이 실린다');
  return value;
}

/** 재설정 링크. 기본 주소의 경로는 버리고 직원 앱의 고정 경로를 쓴다. */
export function resetLinkOf(baseUrl: string, token: string): string {
  const url = new URL(RESET_LINK_PATH, baseUrl);
  url.searchParams.set('token', token);
  return url.toString();
}
```

- [ ] **Step 4: 통과 확인** — Run: `corepack pnpm test staff-app-url`. Expected: `Tests: 6 passed`.

- [ ] **Step 5: 발송기 자리** — `src/auth/password-reset-link-sender.ts`

```ts
/** 링크를 받는 사람. 직원 레코드에 묶인 계정이다. */
export interface PasswordResetLinkTarget {
  accountId: number;
  email: string;
  realName: string;
}

/** 보낼 내용. 메일 템플릿 EMAIL_STAFF_RESET_LINK 의 변수(근무지 · 링크)와 발송 기록에 쓸 값이다. */
export interface PasswordResetLinkMail {
  /** 그 직원 레코드의 점포 이름 */
  storeName: string;
  /** 토큰이 실린 재설정 링크. 로그 · 발송 기록에 원문을 남기지 않는다 */
  link: string;
  expiresAt: Date;
  /** 요청 관리자(admin_accounts.admin_account_id) */
  requestedBy: number;
}

/**
 * 관리자 초기화 재설정 링크를 보내는 쪽(WHALEERP-172). 핀 발송기(`PasswordResetPinSender`)와 같은 자리다 —
 * MailModule 은 import 되는 순간 MAIL_* 가 비면 기동을 멈추고 지금 어느 환경에도 그 값이 없어, 메일 구현은
 * 팀이 MAIL_* 를 정한 뒤 이 자리에 꽂는다(2026-10-13 노영주).
 */
export abstract class PasswordResetLinkSender {
  /** 지금 실제로 보낼 수 있는지. false 면 발급은 503 이다 — 보내지 못하면서 보냈다고 답하지 않게. */
  abstract isAvailable(): boolean;

  abstract send(target: PasswordResetLinkTarget, mail: PasswordResetLinkMail): Promise<void>;
}
```

- [ ] **Step 6: 실패하는 테스트** — `src/auth/noop-password-reset-link.sender.spec.ts`

```ts
import { Logger } from '@nestjs/common';
import { NoopPasswordResetLinkSender } from './noop-password-reset-link.sender';

describe('NoopPasswordResetLinkSender', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });
  const withEnv = (appEnv: string) => {
    process.env.APP_ENV = appEnv;
    delete process.env.NODE_ENV;
    return new NoopPasswordResetLinkSender();
  };

  it('운영이 아니면 쓸 수 있다 — 개발 중에는 메일이 안 나가도 흐름을 끝까지 돌려 본다', () => {
    expect(withEnv('local').isAvailable()).toBe(true);
  });

  it('운영에서는 쓸 수 없다 — 링크를 보내지 못하면서 보냈다고 답하지 않게', () => {
    expect(withEnv('prod').isAvailable()).toBe(false);
  });

  it('운영에서 이 발송기로 뜨면 기동 때 한 번 오류로 남긴다', () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    withEnv('prod').onModuleInit();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('보낼 때 토큰 · 링크를 로그에 남기지 않는다 — 링크가 곧 비밀번호를 바꿀 권한이다', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await withEnv('local').send(
      { accountId: 7, email: 'a@b.com', realName: '홍길동' },
      { storeName: '연남점', link: 'https://x/password-reset/link?token=SECRET', expiresAt: new Date(), requestedBy: 3 },
    );
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('accountId=7');
    expect(logged).not.toContain('SECRET');
  });
});
```

- [ ] **Step 7: 실패 확인** — Run: `corepack pnpm test noop-password-reset-link`. Expected: FAIL, `Cannot find module`.

- [ ] **Step 8: 구현** — `src/auth/noop-password-reset-link.sender.ts`

```ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { isProduction } from '../config/profile';
import { PasswordResetLinkSender, PasswordResetLinkTarget } from './password-reset-link-sender';

/**
 * 아무것도 보내지 않는 링크 발송기. 메일 구현이 꽂히기 전까지 연결해 둔다. 링크 · 토큰은 로그에도 남기지 않는다 —
 * 링크가 곧 비밀번호를 바꿀 권한이다. 운영에서는 쓸 수 없다고 답해 발급이 503 이 되게 하고, 기동은 막지 않는다
 * (핀 발송기 `NoopPasswordResetPinSender` 와 같다).
 */
@Injectable()
export class NoopPasswordResetLinkSender extends PasswordResetLinkSender implements OnModuleInit {
  private readonly logger = new Logger(NoopPasswordResetLinkSender.name);

  onModuleInit(): void {
    if (isProduction())
      this.logger.error('운영에 재설정 링크 발송기가 연결되지 않았다 — 관리자 초기화가 모두 503 이다');
  }

  isAvailable(): boolean {
    return !isProduction();
  }

  send(target: PasswordResetLinkTarget): Promise<void> {
    this.logger.warn(`메일 발송기가 아직 없어 재설정 링크를 보내지 않았다 accountId=${target.accountId}`);
    return Promise.resolve();
  }
}
```

- [ ] **Step 9: 통과 확인** — Run: `corepack pnpm test noop-password-reset-link staff-app-url`. Expected: 10 passed.

- [ ] **Step 10: 커밋**

```bash
git add src/auth/password-reset-link-sender.ts src/auth/noop-password-reset-link.sender.ts src/auth/noop-password-reset-link.sender.spec.ts src/auth/staff-app-url.ts src/auth/staff-app-url.spec.ts
git commit -m "feat: 재설정 링크 발송기 자리와 직원 앱 주소 읽기 추가 (WHALEERP-172)" -m "핀과 같은 발송기 자리에 Noop 을 둔다(운영 503). STAFF_APP_URL 은 운영에서 https 만 받고, 링크는 /password-reset/link?token= 으로 만든다." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 링크 발급 서비스 (관리자)

**Files:**
- Create: `src/auth/password-reset-link.service.ts`
- Test: `src/auth/password-reset-link.service.spec.ts`

**Interfaces:**
- Consumes: `PasswordResetLinkSender` · `PasswordResetLinkTarget` · `PasswordResetLinkMail`(Task 2), `readStaffAppUrl` · `resetLinkOf`(Task 2), `hashToken`(`./password`), `isProduction`(`../config/profile`), `ConfigService`, `PrismaService`, `AuthSessionService`.
- Produces:
  ```ts
  export interface IssuedLink { issuedAt: Date; expiresAt: Date }
  export class PasswordResetLinkService {
    issue(adminAccountId: number, staffMemberId: number): Promise<IssuedLink>;
    // Task 4
    verify(token: string): Promise<void>;
    reset(token: string, newPassword: string): Promise<void>;
  }
  export const LINK_LIFETIME_MS = 24 * 60 * 60 * 1000;
  export const REISSUE_INTERVAL_MS = 60 * 1000;
  ```
  관리 범위(404)는 컨트롤러가 본다(Task 5). 서비스는 범위가 확인된 직원 ID 를 받는다.

- [ ] **Step 1: 실패하는 테스트** — `src/auth/password-reset-link.service.spec.ts`

```ts
import {
  ConflictException,
  HttpException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AuthSessionService } from '../auth-session/auth-session.service';
import { PrismaService } from '../prisma/prisma.service';
import { hashToken } from './password';
import { PasswordResetLinkSender } from './password-reset-link-sender';
import { PasswordResetLinkService } from './password-reset-link.service';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const APP_URL = 'https://staff.whale-erp.com';

describe('PasswordResetLinkService', () => {
  const now = new Date('2026-10-13T03:00:00.000Z');
  const at = (ms: number) => new Date(now.getTime() + ms);

  let service: PasswordResetLinkService;
  let appUrl: string | undefined;
  let prisma: {
    staffMember: { findUnique: jest.Mock };
    account: { findUnique: jest.Mock };
    store: { findUnique: jest.Mock };
    passwordResetLink: { findUnique: jest.Mock; delete: jest.Mock };
    $transaction: jest.Mock;
  };
  let tx: {
    $queryRaw: jest.Mock;
    account: { findUniqueOrThrow: jest.Mock; update: jest.Mock };
    passwordResetLink: {
      findFirst: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      updateMany: jest.Mock;
      create: jest.Mock;
    };
    passwordResetPin: { updateMany: jest.Mock };
    accountChangeHistory: { create: jest.Mock };
  };
  let sender: { isAvailable: jest.Mock; send: jest.Mock };
  let sessions: { revokeAll: jest.Mock };

  const staff = (over: Record<string, unknown> = {}) => ({
    accountId: 7,
    storeId: 3,
    employmentStatus: 'EMPLOYED',
    ...over,
  });

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(now);
    appUrl = APP_URL;
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      account: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ status: 'JOINED' }),
        update: jest.fn().mockResolvedValue({}),
      },
      passwordResetLink: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUniqueOrThrow: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({ passwordResetLinkId: 41 }),
      },
      passwordResetPin: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      accountChangeHistory: { create: jest.fn().mockResolvedValue({}) },
    };
    prisma = {
      staffMember: { findUnique: jest.fn().mockResolvedValue(staff()) },
      account: {
        findUnique: jest.fn().mockResolvedValue({
          accountId: 7,
          email: 'staff@example.com',
          realName: '홍길동',
          status: 'JOINED',
        }),
      },
      store: { findUnique: jest.fn().mockResolvedValue({ name: '연남점' }) },
      passwordResetLink: {
        findUnique: jest.fn().mockResolvedValue(null),
        delete: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest
        .fn()
        .mockImplementation((work: (client: typeof tx) => unknown) => work(tx)),
    };
    sender = {
      isAvailable: jest.fn().mockReturnValue(true),
      send: jest.fn().mockResolvedValue(undefined),
    };
    sessions = { revokeAll: jest.fn().mockResolvedValue(0) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PasswordResetLinkService,
        { provide: PrismaService, useValue: prisma },
        { provide: PasswordResetLinkSender, useValue: sender },
        { provide: AuthSessionService, useValue: sessions },
        { provide: ConfigService, useValue: { get: () => appUrl } },
      ],
    }).compile();
    service = module.get(PasswordResetLinkService);
  });

  afterEach(() => jest.useRealTimers());

  const sentLink = () =>
    (sender.send.mock.calls[0] as [unknown, { link: string }])[1].link;
  const tokenOf = (link: string) => new URL(link).searchParams.get('token') as string;
  const thrown = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return error as HttpException;
    }
    throw new Error('던지지 않았다');
  };

  describe('발급', () => {
    it('201 에 쓸 발송 시각과 24시간 뒤 기한을 돌려준다', async () => {
      await expect(service.issue(31, 5)).resolves.toEqual({
        issuedAt: now,
        expiresAt: at(24 * HOUR),
      });
    });

    it('토큰은 해시만 저장하고, 요청 관리자와 24시간 기한을 남긴다', async () => {
      await service.issue(31, 5);
      const token = tokenOf(sentLink());
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(tx.passwordResetLink.create).toHaveBeenCalledWith({
        data: {
          accountId: 7,
          tokenHash: hashToken(token),
          issuedAt: now,
          expiresAt: at(24 * HOUR),
          requestedBy: 31,
        },
        select: { passwordResetLinkId: true },
      });
    });

    it('직원 앱의 재설정 링크와 점포 이름 · 요청 관리자로 보낸다', async () => {
      await service.issue(31, 5);
      expect(sender.send).toHaveBeenCalledWith(
        { accountId: 7, email: 'staff@example.com', realName: '홍길동' },
        expect.objectContaining({ storeName: '연남점', expiresAt: at(24 * HOUR), requestedBy: 31 }),
      );
      expect(sentLink()).toMatch(/^https:\/\/staff\.whale-erp\.com\/password-reset\/link\?token=/);
    });

    it('앞서 보낸 링크와 열린 핀을 같은 트랜잭션에서 닫는다', async () => {
      await service.issue(31, 5);
      expect(tx.passwordResetLink.updateMany).toHaveBeenCalledWith({
        where: { accountId: 7, closedAt: null },
        data: { closedAt: now },
      });
      expect(tx.passwordResetPin.updateMany).toHaveBeenCalledWith({
        where: { accountId: 7, usedAt: null },
        data: { usedAt: now },
      });
    });

    it('계정 행을 잠근 뒤 직전 발급을 읽는다 — 동시에 눌러도 1분 제한을 넘지 못하게', async () => {
      await service.issue(31, 5);
      const [strings] = tx.$queryRaw.mock.calls[0] as [string[]];
      expect(strings.join('?')).toContain('FOR UPDATE');
      expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.passwordResetLink.findFirst.mock.invocationCallOrder[0],
      );
    });

    it('같은 계정에 1분 안에 낸 링크가 있으면 429 이고 아무것도 바꾸지 않는다', async () => {
      tx.passwordResetLink.findFirst.mockResolvedValue({ issuedAt: at(-MINUTE + 1) });
      const error = await thrown(service.issue(31, 5));
      expect(error.getStatus()).toBe(429);
      expect(tx.passwordResetLink.create).not.toHaveBeenCalled();
      expect(tx.passwordResetPin.updateMany).not.toHaveBeenCalled();
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('1분이 지났으면 다시 보낸다', async () => {
      tx.passwordResetLink.findFirst.mockResolvedValue({ issuedAt: at(-MINUTE) });
      await expect(service.issue(31, 5)).resolves.toBeDefined();
    });

    it.each([
      ['가입 전(계정 없음)', staff({ accountId: null }), '가입'],
      ['퇴직', staff({ employmentStatus: 'RETIRED' }), '퇴직'],
    ])('%s 직원이면 409', async (_, row, word) => {
      prisma.staffMember.findUnique.mockResolvedValue(row);
      const error = await thrown(service.issue(31, 5));
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.message).toContain(word);
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('퇴직 예정(재직이고 퇴직일만 있음)은 보낼 수 있다', async () => {
      prisma.staffMember.findUnique.mockResolvedValue(staff({ employmentStatus: 'EMPLOYED' }));
      await expect(service.issue(31, 5)).resolves.toBeDefined();
    });

    it('탈퇴한 계정이면 409', async () => {
      prisma.account.findUnique.mockResolvedValue({
        accountId: 7,
        email: 'staff@example.com',
        realName: '홍길동',
        status: 'WITHDRAWN',
      });
      const error = await thrown(service.issue(31, 5));
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.message).toContain('탈퇴');
    });

    it('없는 직원이면 404 — 범위 확인 뒤 사이에 지워진 경우', async () => {
      prisma.staffMember.findUnique.mockResolvedValue(null);
      await expect(service.issue(31, 5)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('STAFF_APP_URL 이 비었으면 503 이고 아무것도 저장하지 않는다', async () => {
      appUrl = undefined;
      const module = await Test.createTestingModule({
        providers: [
          PasswordResetLinkService,
          { provide: PrismaService, useValue: prisma },
          { provide: PasswordResetLinkSender, useValue: sender },
          { provide: AuthSessionService, useValue: sessions },
          { provide: ConfigService, useValue: { get: () => undefined } },
        ],
      }).compile();
      await expect(module.get(PasswordResetLinkService).issue(31, 5)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('발송기를 쓸 수 없으면 503 이고 아무것도 저장하지 않는다', async () => {
      sender.isAvailable.mockReturnValue(false);
      await expect(service.issue(31, 5)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('발송에 실패하면 방금 만든 링크를 지우고 503 — 바로 다시 보낼 때 1분 제한에 걸리지 않게', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      sender.send.mockRejectedValue(new Error('smtp down'));
      await expect(service.issue(31, 5)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(prisma.passwordResetLink.delete).toHaveBeenCalledWith({
        where: { passwordResetLinkId: 41 },
      });
    });
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `corepack pnpm test password-reset-link.service`. Expected: FAIL, `Cannot find module './password-reset-link.service'`.

- [ ] **Step 3: 구현** — `src/auth/password-reset-link.service.ts` (verify · reset 은 Task 4 에서 더한다)

```ts
import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { AuthSessionService } from '../auth-session/auth-session.service';
import { isProduction } from '../config/profile';
import { PrismaService } from '../prisma/prisma.service';
import { hashToken } from './password';
import { PasswordResetLinkSender } from './password-reset-link-sender';
import { readStaffAppUrl, resetLinkOf } from './staff-app-url';

/** 링크 수명. 24시간 동안 한 번만 쓴다(WHALEERP-172). */
export const LINK_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** 같은 계정에 다시 보낼 수 있는 간격. 하루 제한은 없다. */
export const REISSUE_INTERVAL_MS = 60 * 1000;

const UNAVAILABLE_MESSAGE = '지금은 재설정 링크를 보낼 수 없습니다. 잠시 뒤에 다시 시도해 주세요';
const INTERVAL_MESSAGE = '방금 재설정 링크를 보냈습니다. 1분 뒤에 다시 보낼 수 있습니다';

export interface IssuedLink {
  issuedAt: Date;
  expiresAt: Date;
}

/**
 * 관리자 초기화 재설정 링크(WHALEERP-172). 관리자가 보내고(issue), 직원이 링크로 확인하고(verify) 새 비밀번호를
 * 정한다(reset). 관리자는 비밀번호를 알 수도 정할 수도 없다 — 링크는 직원 메일함으로만 간다.
 *
 * 링크를 새로 보내면 앞선 링크와 핀을 닫는다. 본인 핀 요청은 링크를 닫지 않는다 — 핀 요청은 이메일만 알면 누구나
 * 보낼 수 있어, 닫으면 남이 관리자 조치를 무력화할 수 있다.
 */
@Injectable()
export class PasswordResetLinkService {
  private readonly logger = new Logger(PasswordResetLinkService.name);
  private readonly appUrl: string | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: PasswordResetLinkSender,
    private readonly sessions: AuthSessionService,
    config: ConfigService,
  ) {
    // 잘못된 값은 여기서 던져 기동을 멈춘다. 비었으면 null — 발송만 503 이다.
    this.appUrl = readStaffAppUrl(config.get<string>('STAFF_APP_URL'), isProduction());
  }

  /**
   * 링크를 보낸다. 관리 범위는 부르는 쪽(컨트롤러)이 확인했다. 관리자 경로라 응답이 직원 상태로 갈려도 드러날 것이
   * 없어, 사유를 메시지로 가른다.
   */
  async issue(adminAccountId: number, staffMemberId: number): Promise<IssuedLink> {
    const staff = await this.prisma.staffMember.findUnique({
      where: { staffMemberId },
      select: { accountId: true, storeId: true, employmentStatus: true },
    });
    // 범위를 확인한 뒤 사이에 지워졌다. 없는 직원과 같게 답한다.
    if (!staff) throw new NotFoundException('직원을 찾을 수 없습니다');
    if (staff.accountId === null)
      throw new ConflictException('가입을 마치지 않은 직원입니다. 재설정 링크 대신 초대를 다시 보내 주세요');
    if (staff.employmentStatus === 'RETIRED')
      throw new ConflictException('퇴직한 직원에게는 재설정 링크를 보낼 수 없습니다');
    const account = await this.prisma.account.findUnique({
      where: { accountId: staff.accountId },
      select: { accountId: true, email: true, realName: true, status: true },
    });
    if (!account || account.status === 'WITHDRAWN')
      throw new ConflictException('탈퇴한 계정입니다');
    if (this.appUrl === null || !this.sender.isAvailable())
      throw new ServiceUnavailableException(UNAVAILABLE_MESSAGE);
    const store = await this.prisma.store.findUnique({
      where: { storeId: staff.storeId },
      select: { name: true },
    });

    const token = randomBytes(32).toString('base64url');
    const issued = await this.prisma.$transaction(async (tx) => {
      // 계정 행을 잠가 같은 계정의 발급이 한 번에 하나씩 지나가게 한다. 잠그지 않으면 동시에 눌린 요청이 모두
      // 「직전 발급 없음」을 읽고 1분 제한을 넘는다.
      await tx.$queryRaw`SELECT 1 FROM accounts WHERE account_id = ${account.accountId} FOR UPDATE`;
      // 시각은 잠금을 잡은 뒤에 잡는다.
      const now = new Date();
      const recent = await tx.passwordResetLink.findFirst({
        where: { accountId: account.accountId },
        orderBy: { issuedAt: 'desc' },
        select: { issuedAt: true },
      });
      if (recent && now.getTime() - recent.issuedAt.getTime() < REISSUE_INTERVAL_MS)
        return null;
      await tx.passwordResetLink.updateMany({
        where: { accountId: account.accountId, closedAt: null },
        data: { closedAt: now },
      });
      await tx.passwordResetPin.updateMany({
        where: { accountId: account.accountId, usedAt: null },
        data: { usedAt: now },
      });
      const expiresAt = new Date(now.getTime() + LINK_LIFETIME_MS);
      const { passwordResetLinkId } = await tx.passwordResetLink.create({
        data: {
          accountId: account.accountId,
          tokenHash: hashToken(token),
          issuedAt: now,
          expiresAt,
          requestedBy: adminAccountId,
        },
        select: { passwordResetLinkId: true },
      });
      return { passwordResetLinkId, issuedAt: now, expiresAt };
    });
    if (issued === null)
      throw new HttpException(INTERVAL_MESSAGE, HttpStatus.TOO_MANY_REQUESTS);

    // 커밋 뒤에 보낸다(롤백돼도 메일은 이미 나간다). 관리자 경로라 핀과 달리 기다린다 — 실패를 관리자에게 알려야 한다.
    try {
      await this.sender.send(
        { accountId: account.accountId, email: account.email, realName: account.realName },
        {
          storeName: store?.name ?? '',
          link: resetLinkOf(this.appUrl, token),
          expiresAt: issued.expiresAt,
          requestedBy: adminAccountId,
        },
      );
    } catch (error) {
      // 보내지 못한 링크는 지운다 — 남겨 두면 관리자가 바로 다시 보낼 때 1분 제한에 걸린다. 앞서 닫은 링크 · 핀은
      // 되살리지 않는다: 새로 보내려던 상황이라 잃는 것이 없다. 토큰 · 링크는 로그에 남기지 않는다.
      await this.prisma.passwordResetLink.delete({
        where: { passwordResetLinkId: issued.passwordResetLinkId },
      });
      this.logger.error(
        `재설정 링크 발송 실패 accountId=${account.accountId}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new ServiceUnavailableException(UNAVAILABLE_MESSAGE);
    }
    return { issuedAt: issued.issuedAt, expiresAt: issued.expiresAt };
  }
}
```

- [ ] **Step 4: 통과 확인** — Run: `corepack pnpm test password-reset-link.service`. Expected: `Tests: 15 passed`(it.each 2건 포함). 실패하면 메시지를 읽고 구현을 고친다(테스트 기대를 구현에 맞춰 바꾸지 않는다).

- [ ] **Step 5: 커밋**

```bash
git add src/auth/password-reset-link.service.ts src/auth/password-reset-link.service.spec.ts
git commit -m "feat: 관리자 재설정 링크 발급 서비스 추가 (WHALEERP-172)" -m "가입 전 · 퇴직 · 탈퇴 409, 같은 계정 1분 429, 주소 · 발송기 없음 503. 계정 행 잠금 아래 앞선 링크 · 핀을 닫고 24시간 링크를 만든다. 발송 실패면 그 링크를 지운다." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 링크 확인 · 새 비밀번호 저장 서비스 (직원)

**Files:**
- Modify: `src/auth/password-reset-link.service.ts` (verify · reset 추가)
- Test: `src/auth/password-reset-link.service.spec.ts` (describe 추가)

**Interfaces:**
- Consumes: `applyNewPassword`(Task 1), `validateNewPassword`(`./password-policy`), `hashPassword` · `hashToken`(`./password`).
- Produces: `verify(token: string): Promise<void>`, `reset(token: string, newPassword: string): Promise<void>`, `export const INVALID_LINK_MESSAGE`.

- [ ] **Step 1: 실패하는 테스트** — `password-reset-link.service.spec.ts` 맨 위에 해시 목을 더하고(진짜 scrypt 는 느리다), 파일 끝 `describe('PasswordResetLinkService')` 안에 두 describe 를 더한다.

맨 위 import 아래:
```ts
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { hashPassword } from './password';

jest.mock('./password', () => ({
  ...jest.requireActual<typeof import('./password')>('./password'),
  hashPassword: jest.fn((plain: string) => Promise.resolve(`hash:${plain}`)),
}));
const hashPasswordMock = hashPassword as jest.Mock;
const NEW_PASSWORD = 'Brand-new-pw1';
```

describe 안:
```ts
  const linkRow = (over: Record<string, unknown> = {}) => ({
    passwordResetLinkId: 41,
    accountId: 7,
    requestedBy: 31,
    closedAt: null,
    expiresAt: at(HOUR),
    account: { email: 'staff@example.com', status: 'JOINED' },
    ...over,
  });

  describe('확인', () => {
    it('쓸 수 있는 링크면 204 — 아무것도 바꾸지 않는다', async () => {
      prisma.passwordResetLink.findUnique.mockResolvedValue(linkRow());
      await expect(service.verify('tok')).resolves.toBeUndefined();
      expect(prisma.passwordResetLink.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tokenHash: hashToken('tok') } }),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it.each([
      ['없는 토큰', null],
      ['닫힌 링크(사용 · 대체)', linkRow({ closedAt: at(-MINUTE) })],
      ['만료된 링크', linkRow({ expiresAt: at(-1) })],
      ['만료 시각과 같은 순간', linkRow({ expiresAt: now })],
      ['탈퇴한 계정', linkRow({ account: { email: 'staff@example.com', status: 'WITHDRAWN' } })],
    ])('%s 는 사유를 가리지 않고 같은 401', async (_, row) => {
      prisma.passwordResetLink.findUnique.mockResolvedValue(row);
      const error = await thrown(service.verify('tok'));
      expect(error).toBeInstanceOf(UnauthorizedException);
      expect(error.message).toBe(
        '쓸 수 없는 링크입니다. 관리자에게 다시 청하거나 비밀번호 찾기로 인증번호를 받아 다시 정해 주세요',
      );
    });
  });

  describe('새 비밀번호 저장', () => {
    beforeEach(() => {
      prisma.passwordResetLink.findUnique.mockResolvedValue(linkRow());
      tx.passwordResetLink.findUniqueOrThrow.mockResolvedValue(linkRow());
    });

    it('링크를 잠금 안에서 다시 읽고 새 비밀번호를 적용한다 — 관리자 초기화 · 요청 관리자로 남긴다', async () => {
      await expect(service.reset('tok', NEW_PASSWORD)).resolves.toBeUndefined();
      expect(tx.account.update).toHaveBeenCalledWith({
        where: { accountId: 7 },
        data: { passwordHash: `hash:${NEW_PASSWORD}`, failedLoginCount: 0, lockExpiresAt: null },
      });
      expect(tx.passwordResetLink.updateMany).toHaveBeenCalledWith({
        where: { accountId: 7, closedAt: null },
        data: { closedAt: now },
      });
      expect(tx.passwordResetPin.updateMany).toHaveBeenCalledWith({
        where: { accountId: 7, usedAt: null },
        data: { usedAt: now },
      });
      expect(sessions.revokeAll).toHaveBeenCalledWith(7, tx);
      expect(tx.accountChangeHistory.create).toHaveBeenCalledWith({
        data: { accountId: 7, field: 'PASSWORD', channel: 'ADMIN_RESET', requestedBy: 31 },
      });
    });

    it('비밀번호 해시는 잠금을 잡기 전에 만든다 — 잠금 안에서 scrypt 로 줄 서지 않게', async () => {
      await service.reset('tok', NEW_PASSWORD);
      expect(hashPasswordMock.mock.invocationCallOrder.at(-1)).toBeLessThan(
        tx.$queryRaw.mock.invocationCallOrder[0],
      );
    });

    it('규칙에 어긋나면 400 과 사유 — 링크는 닫지 않아 다시 정할 수 있다', async () => {
      const error = await thrown(service.reset('tok', 'short'));
      expect(error).toBeInstanceOf(BadRequestException);
      expect(tx.account.update).not.toHaveBeenCalled();
      expect(tx.passwordResetLink.updateMany).not.toHaveBeenCalled();
    });

    it('기다리는 사이 닫힌 링크면 규칙 사유가 아니라 401 — 닫힌 링크에 「링크는 맞다」고 답하지 않게', async () => {
      tx.passwordResetLink.findUniqueOrThrow.mockResolvedValue(linkRow({ closedAt: at(-1) }));
      await expect(service.reset('tok', 'short')).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(service.reset('tok', NEW_PASSWORD)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(tx.account.update).not.toHaveBeenCalled();
    });

    it('잠금 밖에서 이미 쓸 수 없는 링크면 401 이고 트랜잭션을 열지 않는다', async () => {
      prisma.passwordResetLink.findUnique.mockResolvedValue(null);
      await expect(service.reset('tok', NEW_PASSWORD)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('계정 행을 잠근 뒤 링크를 다시 읽는다 — 같은 링크로 동시에 두 번 정하지 못하게', async () => {
      await service.reset('tok', NEW_PASSWORD);
      const [strings] = tx.$queryRaw.mock.calls[0] as [string[]];
      expect(strings.join('?')).toContain('FOR UPDATE');
      expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.passwordResetLink.findUniqueOrThrow.mock.invocationCallOrder[0],
      );
    });
  });
```

- [ ] **Step 2: 실패 확인** — Run: `corepack pnpm test password-reset-link.service`. Expected: 새 테스트들이 `service.verify is not a function` 등으로 FAIL, 발급 테스트는 그대로 passed.

- [ ] **Step 3: 구현** — `password-reset-link.service.ts` 에 더한다.

import 추가:
```ts
import { BadRequestException, UnauthorizedException } from '@nestjs/common'; // 기존 import 줄에 합친다
import { applyNewPassword } from './apply-new-password';
import { hashPassword, hashToken } from './password'; // 기존 hashToken import 를 이 줄로
import { validateNewPassword } from './password-policy';
```

상수와 판정 함수(클래스 밖):
```ts
/** 만료 · 사용 · 대체 · 없는 토큰 · 탈퇴를 가리지 않는다(WHALEERP-172). */
export const INVALID_LINK_MESSAGE =
  '쓸 수 없는 링크입니다. 관리자에게 다시 청하거나 비밀번호 찾기로 인증번호를 받아 다시 정해 주세요';

interface LinkState {
  closedAt: Date | null;
  expiresAt: Date;
  account: { status: string };
}

/** 쓸 수 있는 링크인지. 만료 시각과 같은 순간도 만료다. */
function isUsableLink(link: LinkState | null, now: Date): link is LinkState {
  return (
    link !== null &&
    link.closedAt === null &&
    link.expiresAt.getTime() > now.getTime() &&
    link.account.status !== 'WITHDRAWN'
  );
}

const LINK_SELECT = {
  passwordResetLinkId: true,
  accountId: true,
  requestedBy: true,
  closedAt: true,
  expiresAt: true,
  account: { select: { email: true, status: true } },
} as const;
```

클래스 안 메서드:
```ts
  /** 링크가 쓸 수 있는지만 본다. 소진하지 않는다 — 메일 보안 스캐너가 미리 열어도 닫히지 않게. */
  async verify(token: string): Promise<void> {
    const link = await this.prisma.passwordResetLink.findUnique({
      where: { tokenHash: hashToken(token) },
      select: LINK_SELECT,
    });
    if (!isUsableLink(link, new Date())) throw new UnauthorizedException(INVALID_LINK_MESSAGE);
  }

  /**
   * 링크로 새 비밀번호를 정한다. 규칙 검사 · 해시는 잠금 밖에서 하고, 계정 행을 잠근 뒤 링크를 다시 읽어 아직 쓸 수
   * 있을 때만 반영한다 — 같은 링크로 동시에 두 번 정하지 못하게. 규칙 위반 사유는 잠금 안에서 링크가 쓸 수 있다고
   * 확인한 뒤에만 준다. 거절(400 · 401)은 트랜잭션 밖에서 던진다.
   */
  async reset(token: string, newPassword: string): Promise<void> {
    const found = await this.prisma.passwordResetLink.findUnique({
      where: { tokenHash: hashToken(token) },
      select: LINK_SELECT,
    });
    if (!isUsableLink(found, new Date())) throw new UnauthorizedException(INVALID_LINK_MESSAGE);
    const reason = validateNewPassword(newPassword, found.account.email);
    const passwordHash = reason === null ? await hashPassword(newPassword) : null;

    const outcome = await this.prisma.$transaction(
      async (tx): Promise<'ok' | 'unusable' | 'rejected'> => {
        await tx.$queryRaw`SELECT 1 FROM accounts WHERE account_id = ${found.accountId} FOR UPDATE`;
        const now = new Date();
        const row = await tx.passwordResetLink.findUniqueOrThrow({
          where: { passwordResetLinkId: found.passwordResetLinkId },
          select: LINK_SELECT,
        });
        if (!isUsableLink(row, now)) return 'unusable';
        if (passwordHash === null) return 'rejected';
        await applyNewPassword(tx, this.sessions, {
          accountId: row.accountId,
          passwordHash,
          now,
          channel: 'ADMIN_RESET',
          requestedBy: row.requestedBy,
        });
        return 'ok';
      },
    );
    if (outcome === 'unusable') throw new UnauthorizedException(INVALID_LINK_MESSAGE);
    if (outcome === 'rejected') throw new BadRequestException(reason);
  }
```

- [ ] **Step 4: 통과 확인** — Run: `corepack pnpm test password-reset-link.service`. Expected: 발급 + 확인 + 저장 모두 passed(27건 안팎). Run: `corepack pnpm exec tsc --noEmit -p tsconfig.json`. Expected: 오류 없음(`reason` 이 `string | null` 이라 `BadRequestException(reason)` 이 타입 오류면 `reason ?? undefined` 로 넘긴다 — 'rejected' 는 `passwordHash === null`, 곧 `reason !== null` 일 때만 나온다).

- [ ] **Step 5: 커밋**

```bash
git add src/auth/password-reset-link.service.ts src/auth/password-reset-link.service.spec.ts
git commit -m "feat: 재설정 링크 확인과 새 비밀번호 저장 서비스 추가 (WHALEERP-172)" -m "확인은 소진하지 않고 사유 없이 같은 401. 저장은 잠금 아래 링크를 다시 읽고, 규칙 위반은 링크를 닫지 않고 400. 성공하면 applyNewPassword 로 링크 · 핀 · 세션을 정리하고 ADMIN_RESET 이력." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 컨트롤러 · DTO · 모듈 · 요청 제한

**Files:**
- Create: `src/auth/dto/verify-password-reset-link.dto.ts`, `src/auth/dto/reset-password-with-link.dto.ts`, `src/auth/dto/password-reset-link.response.dto.ts`
- Create: `src/auth/password-reset-link.controller.ts`, `src/auth/password-reset-link-admin.controller.ts`
- Modify: `src/auth/auth.module.ts`, `src/auth/throttle.ts`, `src/auth/throttle.spec.ts`, `.env.example`

**Interfaces:**
- Consumes: `PasswordResetLinkService.issue/verify/reset`(Task 3 · 4), `AdminScopeService.canManageStaffMember`(`../admin-scope/admin-scope.service`), `Public` · `CurrentUser` · `UserTypes`(`./auth.decorators`), `AuthUser`(`./auth.types`), `PasswordResetLinkSender` · `NoopPasswordResetLinkSender`(Task 2).
- Produces: HTTP 경로 `POST /staff-members/:id/password-reset-links`(201), `POST /auth/account/password-reset-links/verify`(204), `POST /auth/account/password-reset-links/reset`(204).

- [ ] **Step 1: 요청 제한 테스트 먼저** — `src/auth/throttle.spec.ts` 의 「갱신은 갱신 토큰으로 센다」 테스트 바로 위에 더한다:

```ts
  it('재설정 링크는 본문 token 의 해시로 센다 — 저장소에 토큰 원문이 남지 않게', () => {
    const key = accountTracker({ ip: '1.2.3.4', body: { token: 'link-secret' } });
    expect(key).toBe(`token:${hashToken('link-secret')}`);
    expect(key).not.toContain('link-secret');
  });
```
  Run: `corepack pnpm test throttle`. Expected: FAIL(`ip:1.2.3.4` 를 돌려줌).

- [ ] **Step 2: 요청 제한 구현** — `src/auth/throttle.ts`
  - `accountTracker` 의 `const token = bodyRefreshToken(req) ?? bearerToken(req);` 를 `const token = bodyRefreshToken(req) ?? bodyLinkToken(req) ?? bearerToken(req);` 로 바꾼다.
  - 그 위 주석 「갱신은 본문의 갱신 토큰, 로그아웃은 Bearer 토큰으로 센다.」 를 「갱신은 본문의 갱신 토큰, 재설정 링크는 본문 token, 로그아웃은 Bearer 토큰으로 센다.」 로 고친다.
  - `bodyRefreshToken` 아래에 더한다:
    ```ts
    /** 관리자 초기화 재설정 링크의 토큰(WHALEERP-172). */
    function bodyLinkToken(req: Record<string, unknown>): string | undefined {
      const token = (req.body as { token?: unknown } | undefined)?.token;
      return typeof token === 'string' && token ? token : undefined;
    }
    ```
  - 파일 머리 주석의 계정 축 순서 설명(본문 이메일 → … → Bearer 토큰 → IP)에 「본문 재설정 링크 토큰」을 갱신 토큰 다음에 넣는다.
  Run: `corepack pnpm test throttle`. Expected: passed.

- [ ] **Step 3: DTO** —

`src/auth/dto/verify-password-reset-link.dto.ts`
```ts
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class VerifyPasswordResetLinkDto {
  /** 메일 링크의 token 쿼리 값. 모양이 틀려도 400 이 아니라 쓸 수 없는 링크(401)다. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  token: string;
}
```

`src/auth/dto/reset-password-with-link.dto.ts`
```ts
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ResetPasswordWithLinkDto {
  /** 메일 링크의 token 쿼리 값 */
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  token: string;

  /**
   * 새 비밀번호. 문자 종류와 길이 규칙은 서버가 검사하고 어긋나면 사유를 준다(링크는 그대로). 여기서는 터무니없이
   * 긴 입력(scrypt 에 큰 값을 먹이는 일)만 막는다.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  newPassword: string;
}
```

`src/auth/dto/password-reset-link.response.dto.ts`
```ts
export class PasswordResetLinkResponseDto {
  /** 링크를 보낸 시각 */
  issuedAt: Date;
  /** 링크가 쓸 수 없게 되는 시각 — 보낸 때부터 24시간 */
  expiresAt: Date;
}
```

- [ ] **Step 4: 직원용 컨트롤러** — `src/auth/password-reset-link.controller.ts`

```ts
import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Public } from './auth.decorators';
import { ResetPasswordWithLinkDto } from './dto/reset-password-with-link.dto';
import { VerifyPasswordResetLinkDto } from './dto/verify-password-reset-link.dto';
import { PasswordResetLinkService } from './password-reset-link.service';

// 로그인 전에 닿는 경로다. 로그인 · 핀과 같은 두 축(IP, 계정 축은 본문 token 의 해시)의 요청 제한을 건다.
@UseGuards(ThrottlerGuard)
@Controller('auth/account/password-reset-links')
export class PasswordResetLinkController {
  constructor(private readonly links: PasswordResetLinkService) {}

  /**
   * 관리자 초기화 재설정 링크가 쓸 수 있는지 확인한다(WHALEERP-172). 화면을 열 때 무효한 링크 안내를 먼저 보이려고
   * 쓴다. 소진하지 않는다.
   */
  @Public()
  @Post('verify')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiUnauthorizedResponse({ description: '쓸 수 없는 링크 — 없음 · 만료 · 사용 · 새 링크로 대체 · 탈퇴를 가리지 않는다' })
  verify(@Body() dto: VerifyPasswordResetLinkDto): Promise<void> {
    return this.links.verify(dto.token);
  }

  /**
   * 링크로 새 비밀번호를 정한다. 지금 비밀번호는 묻지 않는다. 성공하면 남은 링크 · 핀을 닫고 모든 기기의 접속을
   * 끊으며 로그인 잠금을 푼다.
   */
  @Public()
  @Post('reset')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBadRequestResponse({ description: '비밀번호 규칙 위반 — 사유를 준다. 링크는 그대로라 다시 정할 수 있다' })
  @ApiUnauthorizedResponse({ description: '쓸 수 없는 링크(확인과 같은 문구)' })
  reset(@Body() dto: ResetPasswordWithLinkDto): Promise<void> {
    return this.links.reset(dto.token, dto.newPassword);
  }
}
```

- [ ] **Step 5: 관리자용 컨트롤러** — `src/auth/password-reset-link-admin.controller.ts`

```ts
import { Controller, HttpCode, HttpStatus, NotFoundException, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiServiceUnavailableResponse,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { CurrentUser, UserTypes } from './auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from './auth.types';
import { PasswordResetLinkResponseDto } from './dto/password-reset-link.response.dto';
import { PasswordResetLinkService } from './password-reset-link.service';

const NOT_FOUND_MESSAGE = '직원을 찾을 수 없습니다';
const MAX_ID = 2_147_483_647;

/**
 * 직원 비밀번호 초기화(WHALEERP-172 · 177). 관리자 웹만 쓴다. 관리자는 비밀번호를 알 수도 정할 수도 없다 — 재설정
 * 링크가 직원 메일함으로 간다. 관리 범위 밖 · 본사에게 가린 직원은 없는 직원과 같은 404 다(퇴직 처리와 같다).
 * 링크 서비스 · 발송기가 AuthModule 에 있어 여기 둔다. 경로만 직원 자원 아래다.
 */
@ApiBearerAuth()
@UserTypes('admin')
@Controller('staff-members')
export class PasswordResetLinkAdminController {
  constructor(
    private readonly links: PasswordResetLinkService,
    private readonly scope: AdminScopeService,
  ) {}

  /** 재설정 링크를 보낸다. 앞서 보낸 링크와 핀은 무효가 된다. 응답의 시각으로 「보낸 시각 · 기한」을 그린다. */
  @Post(':id/password-reset-links')
  @HttpCode(HttpStatus.CREATED)
  @ApiNotFoundResponse({ description: '없는 직원이거나 관리 범위 밖' })
  @ApiConflictResponse({ description: '가입 전 · 퇴직 · 탈퇴' })
  @ApiTooManyRequestsResponse({ description: '같은 계정에 1분 안에 다시 보냄' })
  @ApiServiceUnavailableResponse({ description: '링크 주소 · 발송기가 없거나 발송 실패' })
  async issue(
    @CurrentUser() user: AuthUser,
    @Param('id') rawId: string,
  ): Promise<PasswordResetLinkResponseDto> {
    // 정수 범위 밖이면 DB 에 묻기 전에 404 다 — 그대로 보내면 PostgreSQL 이 오류를 내 404 가 500 이 된다.
    const id = /^\d{1,10}$/.test(rawId) ? Number(rawId) : 0;
    if (id < 1 || id > MAX_ID) throw new NotFoundException(NOT_FOUND_MESSAGE);
    if (!(await this.scope.canManageStaffMember(user.id, id)))
      throw new NotFoundException(NOT_FOUND_MESSAGE);
    return this.links.issue(user.id, id);
  }
}
```

- [ ] **Step 6: 모듈 등록** — `src/auth/auth.module.ts`
  - import 추가: `AdminScopeModule`(`../admin-scope/admin-scope.module`), `PasswordResetLinkController`, `PasswordResetLinkAdminController`, `PasswordResetLinkService`, `PasswordResetLinkSender`, `NoopPasswordResetLinkSender`.
  - `imports` 에 `AdminScopeModule` 을 더한다.
  - `controllers` 에 `PasswordResetLinkController, PasswordResetLinkAdminController` 를 더한다.
  - `providers` 에 더한다:
    ```ts
    PasswordResetLinkService,
    // 메일 구현(MAIL_* 설정)이 정해지면 이 자리를 그 구현으로 바꾼다 — 핀 발송기와 함께(WHALEERP-172).
    { provide: PasswordResetLinkSender, useClass: NoopPasswordResetLinkSender },
    ```

- [ ] **Step 7: 설정 키** — `.env.example` 의 `MAIL_PASSWORD=` 아래에 더한다:
  ```
  # 직원 앱 주소. 관리자 초기화 재설정 링크가 <이 주소>/password-reset/link?token=… 로 간다.
  # 운영은 https 만. 비우면 api 는 뜨고 링크 발송만 503 이다.
  STAFF_APP_URL=
  ```

- [ ] **Step 8: 확인** — Run: `corepack pnpm exec tsc --noEmit -p tsconfig.json && corepack pnpm lint && corepack pnpm test`. Expected: tsc 오류 없음, lint 0, 단위 전체 passed. Run: `corepack pnpm build`. Expected: 성공.

- [ ] **Step 9: 커밋**

```bash
git add src/auth/dto/verify-password-reset-link.dto.ts src/auth/dto/reset-password-with-link.dto.ts src/auth/dto/password-reset-link.response.dto.ts src/auth/password-reset-link.controller.ts src/auth/password-reset-link-admin.controller.ts src/auth/auth.module.ts src/auth/throttle.ts src/auth/throttle.spec.ts .env.example
git commit -m "feat: 관리자 재설정 링크 API 경로 추가 (WHALEERP-172)" -m "POST /staff-members/:id/password-reset-links(관리자, 201), POST /auth/account/password-reset-links/verify · reset(직원, 로그인 없이). 요청 제한 계정 축이 본문 token 해시로 센다. STAFF_APP_URL 설정 키 추가." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 실제 DB e2e

**Files:**
- Create: `test/password-reset-link.e2e-spec.ts`
- Modify: `test/account-status-policy.e2e-spec.ts` (경로 목록 · 주석)

**Interfaces:**
- Consumes: Task 5 의 HTTP 경로, `PasswordResetLinkSender`(가짜로 바꿔 끼움), `JwtService`(관리자 토큰), `hashPassword`.

- [ ] **Step 1: e2e 쓰기** — `test/password-reset-link.e2e-spec.ts`

```ts
import { randomInt } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { hashPassword } from '../src/auth/password';
import {
  PasswordResetLinkMail,
  PasswordResetLinkSender,
  PasswordResetLinkTarget,
} from '../src/auth/password-reset-link-sender';
import { PasswordResetPinSender } from '../src/auth/password-reset-pin-sender';
import { PrismaService } from '../src/prisma/prisma.service';

const OLD_PASSWORD = 'old-Password-1';
const NEW_PASSWORD = 'Brand-new-pw1';

/** 메일 대신 받은 링크를 모아 둔다. 메일 구현이 없어도 흐름 전체를 돌린다. */
class CapturingLinkSender extends PasswordResetLinkSender {
  readonly sent: { email: string; mail: PasswordResetLinkMail }[] = [];
  isAvailable() {
    return true;
  }
  send(target: PasswordResetLinkTarget, mail: PasswordResetLinkMail) {
    this.sent.push({ email: target.email, mail });
    return Promise.resolve();
  }
}
class CapturingPinSender extends PasswordResetPinSender {
  readonly sent: { email: string; pin: string }[] = [];
  isAvailable() {
    return true;
  }
  send(target: { email: string }, pin: string) {
    this.sent.push({ email: target.email, pin });
    return Promise.resolve();
  }
}

// 관리자 초기화 재설정 링크(WHALEERP-172)를 실제 DB 로 확인한다. 동시 저장 · 핀과의 상호 무효는 행 잠금과 여러 표에
// 걸쳐 있어 목으로는 증명되지 않는다. 요청 제한 가드는 끈다(throttle.spec 이 따로 다룬다).
describe('관리자 초기화 재설정 링크 (e2e, DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const links = new CapturingLinkSender();
  const pins = new CapturingPinSender();
  let oldHash: string;
  let bpCodeId: number;
  let storeId: number;
  let otherStoreId: number;
  let adminId: number;
  let otherAdminId: number;
  const accountIds: number[] = [];
  const staffIds: number[] = [];

  beforeAll(async () => {
    if (process.env.APP_ENV !== 'test' || !process.env.DATABASE_URL)
      throw new Error('APP_ENV=test 와 일회용 DB 의 DATABASE_URL 을 주고 돌린다 — 공용 DB 에서 돌면 안 된다');
    // ConfigService.get 은 파일에 없는 키를 process.env 에서 읽는다. 앱을 만들기 전에 넣어야 서비스 생성자가 읽는다.
    process.env.STAFF_APP_URL = 'https://staff.test.invalid';
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideProvider(PasswordResetLinkSender)
      .useValue(links)
      .overrideProvider(PasswordResetPinSender)
      .useValue(pins)
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    oldHash = await hashPassword(OLD_PASSWORD);

    const n = randomInt(100_000, 999_999);
    ({ bpCodeId } = await prisma.bpCode.create({
      data: { bpCode: `BP${n}`, isPlatform: false, accountStatusCode: 'ACTIVE', tradeName: '링크 테스트 BP' },
    }));
    ({ storeId } = await prisma.store.create({
      data: { storeCode: `ST${n}`, bpCodeId, storeTypeCode: 'DIRECT', name: '링크 테스트 점포', storeStatusCode: 'OPERATING' },
    }));
    ({ storeId: otherStoreId } = await prisma.store.create({
      data: { storeCode: `ST${(n + 1) % 1_000_000}`, bpCodeId, storeTypeCode: 'DIRECT', name: '다른 점포', storeStatusCode: 'OPERATING' },
    }));
    const roleGroup = await prisma.roleGroup.findFirstOrThrow({ where: { roleCode: 'BM000001' } });
    ({ adminAccountId: adminId } = await prisma.adminAccount.create({
      data: {
        loginId: `link${n}`, bpCodeId, passwordHash: '!', roleTypeCode: 'BM', roleGroupId: roleGroup.roleGroupId,
        joinPathCode: 'PLATFORM_REGISTERED', isAllStores: true, accountStatusCode: 'ACTIVE',
      },
    }));
    ({ adminAccountId: otherAdminId } = await prisma.adminAccount.create({
      data: {
        loginId: `lnko${n}`, bpCodeId, passwordHash: '!', roleTypeCode: 'BA', roleGroupId: roleGroup.roleGroupId,
        joinPathCode: 'PLATFORM_REGISTERED', isAllStores: false, accountStatusCode: 'ACTIVE',
        storeMappings: { create: { storeId: otherStoreId } },
      },
    }));
  });

  afterAll(async () => {
    const byAccount = { accountId: { in: accountIds } };
    await prisma.passwordResetLink.deleteMany({ where: byAccount });
    await prisma.passwordResetPin.deleteMany({ where: byAccount });
    await prisma.accountChangeHistory.deleteMany({ where: byAccount });
    await prisma.authSession.deleteMany({ where: byAccount });
    await prisma.loginHistory.deleteMany({ where: byAccount });
    await prisma.staffMember.deleteMany({ where: { staffMemberId: { in: staffIds } } });
    await prisma.account.deleteMany({ where: byAccount });
    await prisma.adminStoreMapping.deleteMany({ where: { adminAccountId: { in: [adminId, otherAdminId] } } });
    await prisma.adminAccount.deleteMany({ where: { adminAccountId: { in: [adminId, otherAdminId] } } });
    await prisma.store.deleteMany({ where: { storeId: { in: [storeId, otherStoreId] } } });
    await prisma.bpCode.deleteMany({ where: { bpCodeId } });
    await app.close();
  });

  /** 가입한 직원(계정 + 직원 레코드). joined=false 면 계정 없는 가입 전 직원. */
  async function createStaff(opts: { joined?: boolean; retired?: boolean; withdrawn?: boolean } = {}) {
    const { joined = true, retired = false, withdrawn = false } = opts;
    const n = randomInt(10_000_000, 99_999_999);
    let accountId: number | null = null;
    let email = '';
    if (joined) {
      email = `link-${n}@test.invalid`;
      ({ accountId } = await prisma.account.create({
        data: {
          email, passwordHash: oldHash, realName: '홍길동', birthDate: new Date('1990-01-01'),
          phone: `010${n}`, status: withdrawn ? 'WITHDRAWN' : 'JOINED',
        },
      }));
      accountIds.push(accountId);
    }
    const staff = await prisma.staffMember.create({
      data: {
        storeId, accountId, name: '홍길동', phone: `010${n}`, employmentType: 'PART_TIME', jobTitle: '홀',
        joinStatus: joined ? 'JOINED' : 'DRAFT',
        ...(retired ? { employmentStatus: 'RETIRED', retiredDate: new Date('2026-01-31') } : {}),
      },
    });
    staffIds.push(staff.staffMemberId);
    return { staffMemberId: staff.staffMemberId, accountId, email };
  }

  const api = () => request(app.getHttpServer());
  const adminToken = (sub = adminId) =>
    app.get(JwtService).signAsync({ sub, type: 'admin', email: 'admin@test.invalid', typ: 'access' });
  const issue = async (staffMemberId: number | string, sub = adminId) =>
    api()
      .post(`/staff-members/${staffMemberId}/password-reset-links`)
      .set('Authorization', `Bearer ${await adminToken(sub)}`);
  const lastToken = () => {
    const { link } = links.sent[links.sent.length - 1].mail;
    return new URL(link).searchParams.get('token') as string;
  };
  const verify = (token: string) => api().post('/auth/account/password-reset-links/verify').send({ token });
  const reset = (token: string, newPassword = NEW_PASSWORD) =>
    api().post('/auth/account/password-reset-links/reset').send({ token, newPassword });
  const login = (email: string, password: string) => api().post('/auth/account/login').send({ email, password });
  const pastLinkIssues = (accountId: number) =>
    // 1분 제한을 피하려고 앞서 낸 링크의 발급 시각을 2분 전으로 돌린다.
    prisma.passwordResetLink.updateMany({
      where: { accountId },
      data: { issuedAt: new Date(Date.now() - 2 * 60 * 1000) },
    });

  it('관리자가 보내고 직원이 링크로 새 비밀번호를 정하면, 새 비밀번호로 로그인되고 다른 기기 접속은 끊긴다', async () => {
    const { staffMemberId, email } = await createStaff();
    const before = await login(email, OLD_PASSWORD).expect(200);

    const res = await issue(staffMemberId).expect(201);
    const body = res.body as { issuedAt: string; expiresAt: string };
    expect(new Date(body.expiresAt).getTime() - new Date(body.issuedAt).getTime()).toBe(24 * 60 * 60 * 1000);
    const sent = links.sent[links.sent.length - 1];
    expect(sent.email).toBe(email);
    expect(sent.mail.storeName).toBe('링크 테스트 점포');
    expect(sent.mail.link).toMatch(/^https:\/\/staff\.test\.invalid\/password-reset\/link\?token=/);

    const token = lastToken();
    await verify(token).expect(204);
    await verify(token).expect(204); // 확인은 소진하지 않는다
    await reset(token).expect(204);

    await login(email, NEW_PASSWORD).expect(200);
    await login(email, OLD_PASSWORD).expect(401);
    const oldRefresh = (before.body as { refreshToken: string }).refreshToken;
    await api().post('/auth/account/refresh').send({ refreshToken: oldRefresh }).expect(401);
  });

  it('토큰 원문은 DB 에 없다 — 해시만 남는다', async () => {
    const { staffMemberId, accountId } = await createStaff();
    await issue(staffMemberId).expect(201);
    const row = await prisma.passwordResetLink.findFirstOrThrow({ where: { accountId: accountId! } });
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.tokenHash).not.toBe(lastToken());
    expect(row.requestedBy).toBe(adminId);
  });

  it('링크는 한 번만 — 쓴 링크는 확인 · 저장 모두 401', async () => {
    const { staffMemberId } = await createStaff();
    await issue(staffMemberId).expect(201);
    const token = lastToken();
    await reset(token).expect(204);
    await verify(token).expect(401);
    await reset(token, 'Another-pw-22').expect(401);
  });

  it('만료된 링크는 401', async () => {
    const { staffMemberId, accountId } = await createStaff();
    await issue(staffMemberId).expect(201);
    await prisma.passwordResetLink.updateMany({
      where: { accountId: accountId! },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await verify(lastToken()).expect(401);
  });

  it('새 링크를 보내면 앞 링크는 401 이고, 1분 안 재요청은 429', async () => {
    const { staffMemberId, accountId } = await createStaff();
    await issue(staffMemberId).expect(201);
    const first = lastToken();
    await issue(staffMemberId).expect(429);
    await pastLinkIssues(accountId!);
    await issue(staffMemberId).expect(201);
    await verify(first).expect(401);
    await verify(lastToken()).expect(204);
  });

  it('규칙에 어긋난 비밀번호는 400 과 사유 — 같은 링크로 다시 정할 수 있다', async () => {
    const { staffMemberId } = await createStaff();
    await issue(staffMemberId).expect(201);
    const token = lastToken();
    const bad = await reset(token, 'short').expect(400);
    expect((bad.body as { message: string }).message).toBeTruthy();
    await reset(token).expect(204);
  });

  it('같은 링크로 동시에 두 번 정하면 하나만 성공한다', async () => {
    const { staffMemberId } = await createStaff();
    await issue(staffMemberId).expect(201);
    const token = lastToken();
    const statuses = (await Promise.all([reset(token), reset(token, 'Other-pw-3333')])).map((r) => r.status).sort();
    expect(statuses).toEqual([204, 401]);
  });

  it('관리자가 링크를 보내면 열린 핀이 닫힌다', async () => {
    const { staffMemberId, email } = await createStaff();
    await api().post('/auth/account/password-reset-pins').send({ email }).expect(204);
    const pin = pins.sent[pins.sent.length - 1].pin;
    await issue(staffMemberId).expect(201);
    await api().post('/auth/account/password-reset-pins/verify').send({ email, pin }).expect(401);
  });

  it('본인 핀 요청은 링크를 닫지 않고, 핀으로 정하면 링크가 닫힌다', async () => {
    const { staffMemberId, email } = await createStaff();
    await issue(staffMemberId).expect(201);
    const token = lastToken();
    await api().post('/auth/account/password-reset-pins').send({ email }).expect(204);
    await verify(token).expect(204);
    const pin = pins.sent[pins.sent.length - 1].pin;
    await api().post('/auth/account/password-reset').send({ email, pin, newPassword: NEW_PASSWORD }).expect(204);
    await verify(token).expect(401);
  });

  it('이력은 관리자 초기화와 요청 관리자로 남는다', async () => {
    const { staffMemberId, accountId } = await createStaff();
    await issue(staffMemberId).expect(201);
    await reset(lastToken()).expect(204);
    const history = await prisma.accountChangeHistory.findFirstOrThrow({
      where: { accountId: accountId! },
      orderBy: { accountChangeHistoryId: 'desc' },
    });
    expect(history).toEqual(
      expect.objectContaining({ field: 'PASSWORD', channel: 'ADMIN_RESET', requestedBy: adminId, beforeValue: null, afterValue: null }),
    );
  });

  describe('관리자 쪽 거절', () => {
    it('관리 범위 밖 직원 · 없는 직원 · 범위 밖 ID 는 같은 404', async () => {
      const { staffMemberId } = await createStaff();
      await issue(staffMemberId, otherAdminId).expect(404);
      await issue(2_147_483_647).expect(404);
      await issue('99999999999').expect(404);
    });

    it('가입 전 · 퇴직 · 탈퇴는 409', async () => {
      await issue((await createStaff({ joined: false })).staffMemberId).expect(409);
      await issue((await createStaff({ retired: true })).staffMemberId).expect(409);
      await issue((await createStaff({ withdrawn: true })).staffMemberId).expect(409);
    });

    it('직원 앱 토큰으로는 401 또는 403 — 관리자 경로에 닿지 않는다', async () => {
      const { staffMemberId, accountId } = await createStaff();
      const token = await app
        .get(JwtService)
        .signAsync({ sub: accountId, type: 'account', email: 'x@test.invalid', typ: 'access' });
      const res = await api()
        .post(`/staff-members/${staffMemberId}/password-reset-links`)
        .set('Authorization', `Bearer ${token}`);
      expect([401, 403]).toContain(res.status);
    });
  });
});
```

- [ ] **Step 2: 직원 경로 허용 목록** — `test/account-status-policy.e2e-spec.ts`
  - 목록에 두 경로를 정렬 순서대로 더한다(`'/auth/account/password-reset',` 다음 줄):
    ```ts
        '/auth/account/password-reset-links/reset',
        '/auth/account/password-reset-links/verify',
    ```
  - 그 위 주석 끝에 한 문단을 더한다:
    ```ts
      //
      // 2026-10-13 관리자 초기화 재설정 링크(WHALEERP-172)의 직원 쪽 두 경로를 확인하고 더했다. 링크는 직원 메일함으로만
      // 가고 관리자는 받지 못하며, 확인은 쓸 수 있는지만, 저장은 그 링크가 있어야만 된다. 비밀번호 · 토큰을 돌려주지 않는다.
    ```

- [ ] **Step 3: 일회용 DB 에서 돌리기**

```bash
docker run -d --rm --name whale-e2e-pg -p 55446:5432 -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=e2e postgres:18
until docker exec whale-e2e-pg pg_isready -U postgres -d e2e >/dev/null 2>&1; do sleep 1; done; sleep 2
export DATABASE_URL=postgresql://postgres:pw@localhost:55446/e2e APP_ENV=test
export JWT_SECRET=$(node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))")
corepack pnpm exec prisma migrate deploy
corepack pnpm test:e2e test/password-reset-link.e2e-spec.ts test/account-status-policy.e2e-spec.ts test/password-reset.e2e-spec.ts
```
  Expected: 세 파일 모두 passed. 실패하면 응답 본문을 찍어 원인을 읽고 **구현**을 고친다(테스트를 느슨하게 하지 않는다). 직원 앱 토큰 테스트는 세션이 없는 account 토큰이라 401 이 정상이다.

- [ ] **Step 4: 전체 e2e** — 같은 환경에서 `corepack pnpm test:e2e`. Expected: 모두 passed. main 에서 이미 깨진 테스트가 있으면 그 이름을 기록해 두고(이번 변경과 무관함을 확인), 컨테이너를 내린다: `docker stop whale-e2e-pg`.

- [ ] **Step 5: 커밋**

```bash
git add test/password-reset-link.e2e-spec.ts test/account-status-policy.e2e-spec.ts
git commit -m "test: 관리자 재설정 링크 e2e 추가 (WHALEERP-172)" -m "실제 DB 로 발송 → 확인 → 저장 → 로그인, 한 번 · 만료 · 대체 · 1분 제한, 규칙 위반 뒤 재시도, 동시 저장, 핀과의 상호 무효, 이력, 관리자 쪽 404 · 409 를 확인한다. 직원 경로 허용 목록에 두 경로를 더한다." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 문서 · OpenAPI

**Files:**
- Modify: `openapi/openapi.json`(생성), `okf/api/auth.md`, `okf/log.md`, `CLAUDE.md`

- [ ] **Step 1: OpenAPI** — Run: `corepack pnpm openapi:export`. Expected: `openapi/openapi.json — 경로 N · 스키마 M`(경로 3개 늘어남). `git diff --stat openapi` 로 `PasswordResetLinkResponseDto` · `VerifyPasswordResetLinkDto` · `ResetPasswordWithLinkDto` 가 들어갔는지 확인.

- [ ] **Step 2: okf 인증 문서** — `okf/api/auth.md`
  - frontmatter `sources` 에 새 파일들을 더한다(`apply-new-password.ts` · `password-reset-link.service.ts` · `password-reset-link.controller.ts` · `password-reset-link-admin.controller.ts` · `password-reset-link-sender.ts` · `noop-password-reset-link.sender.ts` · `staff-app-url.ts`, 각 `title` 과 `last_modified` = 지금 UTC), 바뀐 `password-reset.service.ts` · `throttle.ts` · `auth.module.ts` 의 `last_modified` 를 올리고 `generated.at` 을 지금 UTC 로.
  - 「What it is」 경로 표에 세 줄(관리자 1 · 직원 2)을 더하고 경로 개수 문장을 고친다.
  - 「Password reset by PIN」 다음에 `# Admin reset link` 절을 쓴다 — 설계 문서의 「정해진 것」 · 판정 순서 · 상호 무효 · 발송기 자리(Noop, MAIL_* 사정) · `STAFF_APP_URL` · 동시 저장 · 확인은 소진하지 않음 · 401 문구 하나를 영어로 요약하고, 핀 절의 「Reset」 단계에 「남은 링크도 닫는다」를 더한다.
  - 「Rate limiting」 의 계정 축 순서에 본문 `token` 해시를 더한다.
  - 「A 관리자 cannot log in as an employee or read a password」 문단의 경로 목록 · 개수를 고친다.

- [ ] **Step 3: 로그 · CLAUDE.md**
  - `okf/log.md` 의 `## 2026-10-13` 아래 맨 위에: `* **Update**: [Authentication](/api/auth.md) — 관리자 초기화 재설정 링크(WHALEERP-172): 관리자 POST /staff-members/:id/password-reset-links(201 발송 시각 · 기한), 직원 POST /auth/account/password-reset-links/verify · reset. 핀 · 링크 공통 applyNewPassword(핀으로 정해도 링크를 닫는다), 발송기 자리는 Noop(MAIL_* 미정), STAFF_APP_URL(운영 https).`
  - `CLAUDE.md` 「Authentication」 의 `/auth/account` 경로 목록에 `password-reset-links/verify`, `password-reset-links/reset` 을 더하고 이슈 범위에 172 를 넣는다. 관리자 경로 `POST /staff-members/:id/password-reset-links` 를 한 줄로 적는다.

- [ ] **Step 4: 최종 확인** — Run: `corepack pnpm lint && corepack pnpm exec tsc --noEmit -p tsconfig.json && corepack pnpm build && corepack pnpm test`. Expected: 모두 통과.

- [ ] **Step 5: 커밋**

```bash
git add openapi/openapi.json okf/api/auth.md okf/log.md CLAUDE.md
git commit -m "docs: 인증 문서에 관리자 재설정 링크 반영 (WHALEERP-172)" -m "okf 인증 절 · 경로 표 · 요청 제한, log, CLAUDE.md 경로 목록, OpenAPI 를 맞춘다." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## 끝난 뒤 (계획 밖, 사람이 정함)

- 푸시 · PR 은 `/ip-commit-push` 와 PR 본문으로. PR 에 「172 완료 조건의 성공 204 → 201 과 발송 시각 · 기한」 Manyfast 반영 요청과, 「핀 · 링크 발송기를 MailService 에 잇는 일은 MAIL_* 결정 뒤」를 적는다.
- 머지는 재영이 한다.
