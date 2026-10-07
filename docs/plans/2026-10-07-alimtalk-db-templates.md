# 알림톡 DB 템플릿 전환 (1단계) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 메일의 렌더를 `src/notification-templates/` 로 옮겨 공용화하고, `AlimtalkService` 가 `notification_templates` 의 ALIMTALK 행에서 문구를 읽어 보내게 한다.

**Architecture:** 순수 함수 두 개(`renderTemplate`, `findSendableTemplate`)를 `src/notification-templates/` 에 두고 `MailService` 와 `AlimtalkService` 가 같이 쓴다. 알림톡의 코드 레지스트리와 제목 처리는 없앤다. 이력 테이블은 2단계(front 논리 ERD 반영 뒤)라 이 계획에 없다.

**Tech Stack:** NestJS 11, Prisma 7 (`PrismaService` 는 `@Global` `PrismaModule`), Jest + ts-jest.

**Spec:** `docs/plans/2026-10-07-alimtalk-db-templates-design.md`

## Global Constraints

- 렌더 규칙은 메일 때와 같다: 템플릿에 없는 변수 · 가림 이름은 던진다, 필수 변수 누락은 던진다(빈 문자열은 값), 선언되지 않은 자리는 던진다, 선택 변수 누락은 빈 문자열, 한 번에 치환, 상속 속성은 값으로 쓰지 않는다, 오류 메시지에 값을 넣지 않는다.
- `escapeBody: true` 면 본문 값을 HTML 이스케이프(`& < > " '`), 기본은 false. 제목은 언제나 그대로. `title: null` 이면 `subject` · `maskedSubject` 도 null.
- 가림 문자열은 `********`.
- 메일 동작은 바뀌지 않는다 — `src/mail/mail.service.spec.ts` 는 수정 없이 통과해야 한다.
- 알림톡: 번호는 숫자만 남겨 `^01\d{8,9}$`, 비즈뿌리오 `templatecode` 는 행의 `kakao_template_code`, 본문은 이스케이프하지 않음, 제목 없음, 앱 로그에 본문을 남기지 않고 번호는 `010****5678`, 실패 로그의 오류 메시지는 1000자까지.
- 예외는 Nest HTTP 예외가 아닌 `Error`.
- 테스트 실행: `pnpm test <파일 이름 일부>` (`--` 쓰지 않는다). 성공 여부는 passed/failed 개수로 본다.
- 커밋 메시지: 영어 type 접두 + 한글 subject. 끝에 두 줄:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01RbA5Wdg9f3TBLB2rwoVAmD`

## Review Focus

1. ALIMTALK 행인데 `kakao_template_code` 가 NULL 인 경우 — DB CHECK 가 막지만, 코드가 `undefined` 를 그대로 보내지 않는지(Task 3: `findSendableTemplate` 결과를 그대로 넘기는지 확인, CHECK 를 근거로 한 단언에 주석).
2. 알림톡 본문의 `<`, `&` 같은 값이 이스케이프되지 않고 그대로 나간다 — Task 3 테스트.
3. 메일이 공용 렌더로 바뀐 뒤에도 본문 값 이스케이프가 유지된다 — Task 1 에서 `mail.service.spec.ts` 무수정 통과.
4. 번호 형식이 틀리면 템플릿을 조회하지도 않는다 — Task 3 테스트.
5. 비즈뿌리오 오류 메시지가 아주 길어도 로그 한 줄이 1000자 근처로 묶인다 — Task 3 테스트.

---

## File Structure

| 파일 | 책임 |
|---|---|
| `src/notification-templates/render-template.ts` | (메일에서 옮김) 변수 검증 · 치환 · 선택적 HTML 이스케이프 · 가림본 |
| `src/notification-templates/find-template.ts` | 발송할 수 있는 템플릿 조회(없음 · 비활성 · 채널 다름은 던짐) |
| `src/mail/mail.service.ts` | 공용 함수로 바꿔 부름 |
| `src/alimtalk/alimtalk.service.ts` | DB 템플릿으로 다시 씀 |
| `src/alimtalk/alimtalk.module.ts` | 레지스트리 프로바이더 제거 |
| `src/alimtalk/alimtalk-templates.ts` | 삭제 |
| `docs/plans/2026-10-07-alimtalk-send-logs-table.md` | 재영님께 전달할 테이블 제안서 |
| `okf/api/alimtalk.md`, `okf/api/mail.md`, `okf/log.md` | 문서 갱신 |

---

### Task 1: 렌더를 `notification-templates` 로 옮겨 공용화

**Files:**
- Move: `src/mail/render-template.ts` → `src/notification-templates/render-template.ts`
- Move: `src/mail/render-template.spec.ts` → `src/notification-templates/render-template.spec.ts`
- Modify: `src/mail/mail.service.ts` (import · 필드 이름)

**Interfaces:**
- Produces:
  ```ts
  type TemplateVariable = { name: string; isRequired?: boolean };
  type TemplateSource = { templateCode: string; title: string | null; body: string; variables: TemplateVariable[] };
  type RenderedTemplate = { subject: string | null; body: string; maskedSubject: string | null; maskedBody: string };
  const MASK = '********';
  function renderTemplate(
    template: TemplateSource,
    values: Record<string, string>,
    maskedVariables?: readonly string[],
    options?: { escapeBody?: boolean },
  ): RenderedTemplate;
  ```

- [ ] **Step 1: 파일 옮기기**

```bash
mkdir -p src/notification-templates
git mv src/mail/render-template.ts src/notification-templates/render-template.ts
git mv src/mail/render-template.spec.ts src/notification-templates/render-template.spec.ts
```

- [ ] **Step 2: 실패하는 테스트로 고치기**

`src/notification-templates/render-template.spec.ts` 를 새 API 로 바꾼다. 기존 12개는 `escapeBody: true` 로 그대로 유지하고(메일 동작), 새 경우 두 개를 더한다. 파일 전체:

```ts
import {
  MASK,
  type TemplateSource,
  renderTemplate,
} from './render-template';

describe('renderTemplate', () => {
  const template: TemplateSource = {
    templateCode: 'EMAIL_TEMP_PASSWORD',
    title: '[WHALE ERP] #{관리자이름} 님 임시 비밀번호',
    body: '<p>#{관리자이름} 님, #{관리자이름} 님</p><p>#{임시비밀번호}</p><a href="#{링크}">바로가기</a>#{추신}',
    variables: [
      { name: '관리자이름', isRequired: true },
      { name: '임시비밀번호', isRequired: true },
      { name: '링크', isRequired: true },
      { name: '추신' },
    ],
  };
  const values = {
    관리자이름: '이서준',
    임시비밀번호: 'x8Rk-2mPq',
    링크: 'https://erp.whale.test/login',
  };
  // 메일처럼 본문을 이스케이프하는 렌더
  const html = (
    t: TemplateSource,
    v: Record<string, string>,
    masked?: readonly string[],
  ) => renderTemplate(t, v, masked, { escapeBody: true });

  it('제목과 본문의 자리를 모두 치환한다', () => {
    const mail = html(template, values);

    expect(mail.subject).toBe('[WHALE ERP] 이서준 님 임시 비밀번호');
    expect(mail.body).toBe(
      '<p>이서준 님, 이서준 님</p><p>x8Rk-2mPq</p><a href="https://erp.whale.test/login">바로가기</a>',
    );
  });

  it('escapeBody 면 본문 값은 HTML 이스케이프하고 제목 값은 그대로 둔다', () => {
    const mail = html(template, {
      ...values,
      관리자이름: `<b>"O'Neil" & co</b>`,
    });

    expect(mail.subject).toBe(
      `[WHALE ERP] <b>"O'Neil" & co</b> 님 임시 비밀번호`,
    );
    expect(mail.body).toContain(
      '<p>&lt;b&gt;&quot;O&#39;Neil&quot; &amp; co&lt;/b&gt; 님',
    );
  });

  it('escapeBody 를 주지 않으면 본문 값도 그대로 넣는다', () => {
    const talk = renderTemplate(template, {
      ...values,
      관리자이름: '<b>A & B</b>',
    });

    expect(talk.body).toContain('<p><b>A & B</b> 님');
  });

  it('제목이 null 이면 subject 와 maskedSubject 도 null 이다', () => {
    const talk = renderTemplate({ ...template, title: null }, values, [
      '임시비밀번호',
    ]);

    expect(talk.subject).toBeNull();
    expect(talk.maskedSubject).toBeNull();
    expect(talk.maskedBody).toContain(`<p>${MASK}</p>`);
  });

  it('속성 안에 들어가는 값의 따옴표가 속성을 깨지 못한다', () => {
    const mail = html(template, {
      ...values,
      링크: 'https://x.test/" onclick="alert(1)',
    });

    expect(mail.body).toContain(
      '<a href="https://x.test/&quot; onclick=&quot;alert(1)">',
    );
  });

  it('값 안의 #{...} 는 다시 치환하지 않는다', () => {
    const mail = html(template, {
      ...values,
      관리자이름: '#{임시비밀번호}',
    });

    expect(mail.body).toContain('<p>#{임시비밀번호} 님');
    expect(mail.subject).toBe('[WHALE ERP] #{임시비밀번호} 님 임시 비밀번호');
  });

  it('넘기지 않은 선택 변수는 빈 문자열이고, 넘기면 값이 들어간다', () => {
    expect(html(template, values).body.endsWith('</a>')).toBe(true);
    expect(
      html(template, { ...values, 추신: '감사합니다' }).body.endsWith(
        '</a>감사합니다',
      ),
    ).toBe(true);
  });

  it('필수 변수가 빠지면 이름을 담아 던진다. 빈 문자열은 값이다', () => {
    // 구조 분해로 빼면 버린 변수가 no-unused-vars 에 걸린다.
    const rest = { 관리자이름: values.관리자이름, 링크: values.링크 };

    expect(() => html(template, rest)).toThrow('임시비밀번호');
    expect(() =>
      html(template, { ...values, 임시비밀번호: '' }),
    ).not.toThrow();
  });

  it('템플릿에 없는 변수를 넘기면 던진다', () => {
    expect(() => html(template, { ...values, 오타: 'x' })).toThrow('오타');
  });

  it('선언되지 않은 자리는 상속 속성을 값으로 쓰지 않고 던진다', () => {
    const broken = { ...template, body: '<p>#{toString}</p>' };

    expect(() => html(broken, values)).toThrow('toString');
  });

  it('가림본은 지정한 변수만 MASK 로 바꾸고, 제목에도 적용한다', () => {
    const mail = html(template, values, ['임시비밀번호', '관리자이름']);

    expect(mail.body).toContain('<p>x8Rk-2mPq</p>');
    expect(mail.maskedBody).toBe(
      `<p>${MASK} 님, ${MASK} 님</p><p>${MASK}</p><a href="https://erp.whale.test/login">바로가기</a>`,
    );
    expect(mail.maskedSubject).toBe(`[WHALE ERP] ${MASK} 님 임시 비밀번호`);
  });

  it('가리지 않으면 가림본은 보낼 것과 같다', () => {
    const mail = html(template, values);

    expect(mail.maskedBody).toBe(mail.body);
    expect(mail.maskedSubject).toBe(mail.subject);
  });

  it('템플릿에 없는 가림 이름은 던진다 — 오타로 평문이 남지 않게', () => {
    expect(() => html(template, values, ['임시비번'])).toThrow('임시비번');
  });

  it('오류 메시지에 값은 담지 않는다', () => {
    const run = () => html(template, { ...values, 오타: 'secret-value' });

    expect(run).toThrow('오타');
    expect(run).not.toThrow('secret-value');
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `pnpm test render-template`
Expected: FAIL — `renderTemplate` / `TemplateSource` 가 export 되지 않음(컴파일 오류)

- [ ] **Step 4: 구현**

`src/notification-templates/render-template.ts` 전체:

```ts
export type TemplateVariable = { name: string; isRequired?: boolean };

export type TemplateSource = {
  templateCode: string;
  /** 알림톡은 제목이 없다(CHECK notification_templates_title_by_channel) */
  title: string | null;
  body: string;
  variables: TemplateVariable[];
};

export type RenderedTemplate = {
  subject: string | null;
  body: string;
  /** 이력에 남길 제목. 가릴 변수 값이 MASK 로 바뀌어 있다 */
  maskedSubject: string | null;
  /** 이력에 남길 본문. 가릴 변수 값이 MASK 로 바뀌어 있다 */
  maskedBody: string;
};

export const MASK = '********';

const PLACEHOLDER = /#\{([^}]+)\}/g;
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * 알림 템플릿의 `#{변수}` 를 채운다. 메일과 알림톡이 같이 쓴다. 메일 본문은 완성된
 * HTML 이라 `escapeBody` 로 값을 이스케이프해 넣고, 알림톡 본문은 텍스트라 그대로
 * 넣는다. 제목은 메일 헤더라 언제나 그대로다. 한 번에 치환하므로 값 안의 `#{...}`
 * 는 다시 치환하지 않는다.
 *
 * 이력용 가림본을 같은 규칙으로 함께 만든다. 템플릿에 없는 변수 이름은 넘긴
 * 값이든 가림 이름이든 던진다 — 가림 이름의 오타가 조용히 지나가면 비밀번호가
 * 이력에 평문으로 남는다. 오류 메시지에 값은 담지 않는다.
 */
export function renderTemplate(
  template: TemplateSource,
  values: Record<string, string>,
  maskedVariables: readonly string[] = [],
  { escapeBody = false }: { escapeBody?: boolean } = {},
): RenderedTemplate {
  const { templateCode: code } = template;
  const declared = new Set(template.variables.map((v) => v.name));

  const unknown = [...Object.keys(values), ...maskedVariables].filter(
    (name) => !declared.has(name),
  );
  if (unknown.length)
    throw new Error(
      `템플릿 ${code} 에 없는 변수입니다: ${unknown.join(', ')}`,
    );
  const missing = template.variables
    .filter((v) => v.isRequired && typeof own(values, v.name) !== 'string')
    .map((v) => v.name);
  if (missing.length)
    throw new Error(
      `템플릿 ${code} 필수 변수가 비었습니다: ${missing.join(', ')}`,
    );

  const masked = { ...values };
  for (const name of maskedVariables) masked[name] = MASK;

  const fill = (text: string, from: Record<string, string>, escape: boolean) =>
    text.replace(PLACEHOLDER, (_, name: string) => {
      if (!declared.has(name))
        throw new Error(
          `템플릿 ${code} 에 선언되지 않은 자리입니다: ${name}`,
        );
      const value = own(from, name) ?? '';
      return escape ? escapeHtml(value) : value;
    });
  const subject = (from: Record<string, string>) =>
    template.title === null ? null : fill(template.title, from, false);

  return {
    subject: subject(values),
    body: fill(template.body, values, escapeBody),
    maskedSubject: subject(masked),
    maskedBody: fill(template.body, masked, escapeBody),
  };
}

/** 자기 속성만 본다. 상속받은 toString 같은 함수가 값으로 끼어들지 않게. */
function own(values: Record<string, string>, name: string): string | undefined {
  return Object.hasOwn(values, name) ? values[name] : undefined;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}
```

- [ ] **Step 5: 렌더 테스트 통과 확인**

Run: `pnpm test render-template`
Expected: PASS, 14 passed

- [ ] **Step 6: 메일 서비스를 새 위치 · 이름으로**

`src/mail/mail.service.ts`:

- import 를 바꾼다:
  ```ts
  import {
    type TemplateVariable,
    renderTemplate,
  } from '../notification-templates/render-template';
  ```
- `renderMail(` 호출을 `renderTemplate(` 로 바꾸고 네 번째 인자 `{ escapeBody: true }` 를 더한다.
- `const masked = { subject: mail.maskedSubject, body: mail.maskedHtml };` 를 다음으로:
  ```ts
  // 위에서 title 이 null 이 아님을 확인했다.
  const masked = { subject: mail.maskedSubject as string, body: mail.maskedBody };
  ```
- `sendMail` 인자의 `subject: mail.subject,` → `subject: mail.subject as string,`, `html: mail.html,` → `html: mail.body,`

- [ ] **Step 7: 메일 테스트 무수정 통과 확인**

Run: `pnpm test mail`
Expected: PASS — `mail.config` · `mail.service` 전부 통과, `mail.service.spec.ts` 는 고치지 않았다

- [ ] **Step 8: 커밋**

```bash
git add src/notification-templates src/mail
git commit -m "refactor: 템플릿 렌더를 notification-templates 로 옮겨 채널 공용으로"
```

---

### Task 2: 발송할 템플릿 조회 `findSendableTemplate`

**Files:**
- Create: `src/notification-templates/find-template.ts`
- Test: `src/notification-templates/find-template.spec.ts`
- Modify: `src/mail/mail.service.ts` (조회를 이 함수로)

**Interfaces:**
- Consumes: `TemplateSource`, `TemplateVariable` (Task 1), `PrismaService`
- Produces:
  ```ts
  type SendableTemplate = TemplateSource & { kakaoTemplateCode: string | null };
  function findSendableTemplate(
    prisma: Pick<PrismaService, 'notificationTemplate'>,
    templateCode: string,
    channel: NotificationTemplateChannel, // from '@prisma/client'
  ): Promise<SendableTemplate>;
  ```

- [ ] **Step 1: 실패하는 테스트 작성**

`src/notification-templates/find-template.spec.ts`:

```ts
import type { PrismaService } from '../prisma/prisma.service';
import { findSendableTemplate } from './find-template';

describe('findSendableTemplate', () => {
  const row = {
    notificationTemplateId: 1,
    templateCode: 'TALK_STAFF_INVITATION',
    channel: 'ALIMTALK',
    templateName: '가입 초대',
    preferenceCategory: null,
    title: null,
    body: '#{근무지}에서 초대합니다',
    variables: [{ name: '근무지', isRequired: true }],
    kakaoTemplateCode: 'WHALE_INVITE_01',
    isActive: true,
  };
  let findUnique: jest.Mock;
  const find = (channel: 'ALIMTALK' | 'EMAIL' = 'ALIMTALK') =>
    findSendableTemplate(
      { notificationTemplate: { findUnique } } as unknown as Pick<
        PrismaService,
        'notificationTemplate'
      >,
      'TALK_STAFF_INVITATION',
      channel,
    );

  beforeEach(() => {
    findUnique = jest.fn().mockResolvedValue(row);
  });

  it('템플릿 코드로 조회해 렌더에 필요한 모양으로 돌려준다', async () => {
    await expect(find()).resolves.toEqual({
      templateCode: 'TALK_STAFF_INVITATION',
      title: null,
      body: '#{근무지}에서 초대합니다',
      variables: [{ name: '근무지', isRequired: true }],
      kakaoTemplateCode: 'WHALE_INVITE_01',
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: { templateCode: 'TALK_STAFF_INVITATION' },
    });
  });

  it('없으면 코드를 담아 던진다', async () => {
    findUnique.mockResolvedValue(null);

    await expect(find()).rejects.toThrow(/TALK_STAFF_INVITATION.*없습니다/);
  });

  it('사용하지 않는 템플릿이면 그 사실을 담아 던진다', async () => {
    findUnique.mockResolvedValue({ ...row, isActive: false });

    await expect(find()).rejects.toThrow(/TALK_STAFF_INVITATION.*사용하지 않는/);
  });

  it('채널이 다르면 두 채널을 담아 던진다', async () => {
    await expect(find('EMAIL')).rejects.toThrow(
      /TALK_STAFF_INVITATION.*EMAIL.*ALIMTALK/,
    );
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm test find-template`
Expected: FAIL — `Cannot find module './find-template'`

- [ ] **Step 3: 구현**

`src/notification-templates/find-template.ts`:

```ts
import type { NotificationTemplateChannel } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { TemplateSource, TemplateVariable } from './render-template';

export type SendableTemplate = TemplateSource & {
  /** 알림톡만. CHECK notification_templates_alimtalk_fields 가 ALIMTALK 행에 값을 보장한다 */
  kakaoTemplateCode: string | null;
};

/**
 * 발송할 수 있는 템플릿을 템플릿 코드로 찾는다. 없거나, 운영자가 껐거나
 * (`is_active = false`), 다른 채널의 템플릿이면 이유를 나눠 던진다 — 운영자가
 * 끈 것과 코드의 오타는 대처가 다르다.
 */
export async function findSendableTemplate(
  prisma: Pick<PrismaService, 'notificationTemplate'>,
  templateCode: string,
  channel: NotificationTemplateChannel,
): Promise<SendableTemplate> {
  const row = await prisma.notificationTemplate.findUnique({
    where: { templateCode },
  });
  if (!row) throw new Error(`템플릿 ${templateCode} 이(가) 없습니다`);
  if (!row.isActive)
    throw new Error(`템플릿 ${templateCode} 은(는) 사용하지 않는 상태입니다`);
  if (row.channel !== channel)
    throw new Error(
      `템플릿 ${templateCode} 은(는) ${channel} 이 아니라 ${row.channel} 채널입니다`,
    );
  return {
    templateCode,
    title: row.title,
    body: row.body,
    // CHECK notification_templates_variables_array 가 배열임을 보장한다.
    variables: row.variables as TemplateVariable[],
    kakaoTemplateCode: row.kakaoTemplateCode,
  };
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm test find-template`
Expected: PASS, 4 passed

- [ ] **Step 5: 메일 서비스가 이 함수를 쓰게**

`src/mail/mail.service.ts` 의 `const template = await this.prisma.notificationTemplate.findUnique(…)` 부터 `renderTemplate(` 호출의 첫 인자 객체까지를 다음으로 바꾼다:

```ts
    const template = await findSendableTemplate(
      this.prisma,
      templateCode,
      'EMAIL',
    );
    if (template.title === null)
      throw new Error(`메일 템플릿 ${templateCode} 에 제목이 없습니다`);

    // 본문은 로그에 남기지 않는다. 이름·임시 비밀번호 같은 개인정보가 들어간다.
    const mail = renderTemplate(
      template,
      input.variables,
      input.maskedVariables,
      { escapeBody: true },
    );
```

import 에 `import { findSendableTemplate } from '../notification-templates/find-template';` 를 더하고, 더는 쓰지 않는 `type TemplateVariable` import 를 지운다.

- [ ] **Step 6: 메일 테스트 무수정 통과 확인**

Run: `pnpm test mail`
Expected: PASS — `mail.service.spec.ts` 는 고치지 않았다. 「템플릿이 없다 · 사용 안 함 · 메일 채널이 아니다」 세 경우가 `EMAIL_TEMP_PASSWORD` 를 담아 던지는 것도 그대로 통과한다.

- [ ] **Step 7: 커밋**

```bash
git add src/notification-templates src/mail/mail.service.ts
git commit -m "feat: 발송할 템플릿 조회를 공용 함수로 — 없음·비활성·채널 다름을 나눠 알림"
```

---

### Task 3: `AlimtalkService` 를 DB 템플릿으로

**Files:**
- Modify (전체 다시 씀): `src/alimtalk/alimtalk.service.ts`, `src/alimtalk/alimtalk.service.spec.ts`
- Modify: `src/alimtalk/alimtalk.module.ts`
- Delete: `src/alimtalk/alimtalk-templates.ts`

**Interfaces:**
- Consumes: `findSendableTemplate` (Task 2), `renderTemplate` (Task 1), `BizppurioClient` · `BizppurioError` · `BizppurioMessage` · `BIZPPURIO_CONFIG` · `BizppurioConfig` (기존)
- Produces:
  ```ts
  type SendAlimtalkInput = {
    templateCode: string;
    to: string;
    variables: Record<string, string>;
    maskedVariables?: readonly string[];
  };
  type AlimtalkSendResult = { refKey: string; messageKey?: string };
  class AlimtalkService { send(input: SendAlimtalkInput): Promise<AlimtalkSendResult> }
  ```

- [ ] **Step 1: 실패하는 테스트로 다시 쓰기**

`src/alimtalk/alimtalk.service.spec.ts` 전체:

```ts
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { AlimtalkService } from './alimtalk.service';
import {
  BizppurioClient,
  BizppurioError,
  type BizppurioMessage,
} from './bizppurio.client';
import { BIZPPURIO_CONFIG } from './bizppurio.config';

describe('AlimtalkService', () => {
  let service: AlimtalkService;
  let client: { sendMessage: jest.Mock };
  let findUnique: jest.Mock;
  let logLog: jest.SpyInstance;
  let logWarn: jest.SpyInstance;

  const template = {
    templateCode: 'TALK_SCHEDULE',
    channel: 'ALIMTALK',
    isActive: true,
    title: null,
    body: '#{name}님, #{date} 근무가 변경되었습니다.',
    variables: [
      { name: 'name', isRequired: true },
      { name: 'date', isRequired: true },
    ],
    kakaoTemplateCode: 'KAKAO_SCHEDULE_01',
  };
  const input = {
    templateCode: 'TALK_SCHEDULE',
    to: '010-1234-5678',
    variables: { name: '홍길동', date: '10/7' },
  };

  beforeEach(async () => {
    logLog = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    logWarn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    client = {
      sendMessage: jest.fn().mockResolvedValue({
        code: 1000,
        description: 'success',
        refkey: 'ref',
        messagekey: 'mk-1',
      }),
    };
    findUnique = jest.fn().mockResolvedValue(template);
    const module = await Test.createTestingModule({
      providers: [
        AlimtalkService,
        { provide: BizppurioClient, useValue: client },
        {
          provide: BIZPPURIO_CONFIG,
          useValue: { account: 'whale', senderKey: 'sender-key' },
        },
        {
          provide: PrismaService,
          useValue: { notificationTemplate: { findUnique } },
        },
      ],
    }).compile();
    service = module.get(AlimtalkService);
    // 모듈 초기화 로그는 세지 않는다.
    logLog.mockClear();
  });

  afterEach(() => jest.restoreAllMocks());

  const sent = () =>
    (client.sendMessage.mock.calls[0] as [BizppurioMessage])[0];

  it('템플릿 코드로 조회해 카카오 템플릿 코드로 보낸다', async () => {
    await service.send(input);

    expect(findUnique).toHaveBeenCalledWith({
      where: { templateCode: 'TALK_SCHEDULE' },
    });
    const { refkey, ...request } = sent();
    expect(refkey).toMatch(/^[0-9a-f]{20}$/);
    expect(request).toEqual({
      account: 'whale',
      type: 'at',
      to: '01012345678',
      content: {
        at: {
          senderkey: 'sender-key',
          templatecode: 'KAKAO_SCHEDULE_01',
          message: '홍길동님, 10/7 근무가 변경되었습니다.',
        },
      },
    });
  });

  it('본문 값은 이스케이프하지 않는다 — 알림톡은 텍스트다', async () => {
    await service.send({ ...input, variables: { name: '<A & B>', date: 'x' } });

    expect(sent().content.at.message).toBe('<A & B>님, x 근무가 변경되었습니다.');
  });

  it('refKey 와 messageKey 를 돌려준다', async () => {
    const result = await service.send(input);

    expect(result).toEqual({ refKey: sent().refkey, messageKey: 'mk-1' });
  });

  it('변수 값 안의 #{...} 는 다시 치환하지 않는다', async () => {
    await service.send({ ...input, variables: { name: '#{date}', date: 'x' } });

    expect(sent().content.at.message).toBe(
      '#{date}님, x 근무가 변경되었습니다.',
    );
  });

  it.each([
    ['필수 변수 누락', { name: '홍길동' }, undefined, 'date'],
    ['문자열이 아닌 값', { name: null as unknown as string, date: 'x' }, undefined, 'name'],
    ['템플릿에 없는 변수', { ...input.variables, 오타: 'x' }, undefined, '오타'],
    ['템플릿에 없는 가림 이름', input.variables, ['이름'], '이름'],
  ])('%s 이면 보내지 않고 던진다', async (_, variables, maskedVariables, name) => {
    await expect(
      service.send({ ...input, variables, maskedVariables }),
    ).rejects.toThrow(name);
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['템플릿이 없다', null, /없습니다/],
    ['사용 안 함', { ...template, isActive: false }, /사용하지 않는/],
    ['알림톡 채널이 아니다', { ...template, channel: 'EMAIL' }, /ALIMTALK/],
  ])('%s 면 보내지 않고 던진다', async (_, row, message) => {
    findUnique.mockResolvedValue(row);

    await expect(service.send(input)).rejects.toThrow(message);
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it.each(['', '010-123', '0101234567890', '+82 10-1234-5678'])(
    '휴대폰 번호가 아니면(%s) 템플릿을 조회하지도 않고 던진다',
    async (to) => {
      const error = await service
        .send({ ...input, to })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      // 오류 메시지는 예외 필터 로그로 나갈 수 있어 번호를 가린다.
      if (to.length >= 8)
        expect((error as Error).message).not.toContain(to.replace(/\D/g, ''));
      expect(findUnique).not.toHaveBeenCalled();
      expect(client.sendMessage).not.toHaveBeenCalled();
    },
  );

  it('접수되면 번호를 가리고 본문은 남기지 않은 채 로그한다', async () => {
    await service.send({ ...input, variables: { name: '홍길동', date: 'secret-date' } });

    expect(logLog).toHaveBeenCalledTimes(1);
    const [line] = logLog.mock.calls[0] as [string];
    expect(line).toContain('TALK_SCHEDULE');
    expect(line).toContain('mk-1');
    expect(line).toContain('010****5678');
    expect(line).not.toContain('01012345678');
    expect(line).not.toContain('secret-date');
  });

  it('비즈뿌리오 오류는 코드를 남기고 그대로 던진다', async () => {
    const error = new BizppurioError('bad', 2000, 200);
    client.sendMessage.mockRejectedValue(error);

    await expect(service.send(input)).rejects.toBe(error);
    const [line] = logWarn.mock.calls[0] as [string];
    expect(line).toContain('code=2000');
    // 네트워크 실패는 code 가 없어, 원인은 메시지로만 남는다.
    expect(line).toContain('bad');
    expect(line).toContain('010****5678');
    expect(line).not.toContain('홍길동');
  });

  it('비즈뿌리오 오류 메시지가 아주 길어도 로그는 1000자까지만 남긴다', async () => {
    client.sendMessage.mockRejectedValue(new Error('e'.repeat(5000)));

    await expect(service.send(input)).rejects.toThrow();
    const [line] = logWarn.mock.calls[0] as [string];
    expect(line).toContain('e'.repeat(1000));
    expect(line).not.toContain('e'.repeat(1001));
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm test alimtalk.service`
Expected: FAIL — 컴파일 오류(`send` 가 객체 하나를 받지 않음) 또는 `PrismaService` 를 주입받지 않아 조회가 일어나지 않음

- [ ] **Step 3: 구현**

`src/alimtalk/alimtalk.service.ts` 전체:

```ts
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { findSendableTemplate } from '../notification-templates/find-template';
import { renderTemplate } from '../notification-templates/render-template';
import { PrismaService } from '../prisma/prisma.service';
import { BizppurioClient, BizppurioError } from './bizppurio.client';
import { BIZPPURIO_CONFIG, type BizppurioConfig } from './bizppurio.config';

export type SendAlimtalkInput = {
  /** notification_templates.template_code. ALIMTALK 채널이어야 한다 */
  templateCode: string;
  /** 휴대폰 번호. 하이픈 · 공백은 떼고 본다 */
  to: string;
  /** 템플릿 variables 의 이름 그대로 */
  variables: Record<string, string>;
  /**
   * 발송 이력에서 ******** 로 남길 변수 — 초대 링크 등. 이력 테이블이 생기기 전인
   * 지금은 템플릿에 있는 이름인지만 검사한다.
   */
  maskedVariables?: readonly string[];
};

export type AlimtalkSendResult = {
  /** 우리가 만든 요청 키. 비즈뿌리오 결과 리포트의 REFKEY 와 같다. */
  refKey: string;
  /** 비즈뿌리오가 붙인 메시지 키 */
  messageKey?: string;
};

const MOBILE = /^01\d{8,9}$/;
const LOG_REASON_LENGTH = 1000;

/**
 * 알림톡 발송의 공통 진입점. 각 도메인은 이 서비스만 주입받아 쓴다.
 *
 * 문구는 `notification_templates` 의 ALIMTALK 템플릿이고, 비즈뿌리오에는 그 행의
 * `kakao_template_code` 로 보낸다. 본문은 카카오에 검수 등록한 문구와 글자 하나까지
 * 같아야 한다 — 다르면 비즈뿌리오가 거절한다.
 *
 * 접수(비즈뿌리오가 받음)까지만 책임진다. 실제 전달 결과는 비즈뿌리오 결과
 * 리포트로 오며 아직 받지 않는다. code 없는 오류(네트워크 · 끊긴 응답)는 「안
 * 갔다」가 아니므로 다시 보내지 않는다. 실패는 던지므로, 발송이 본 작업을 막으면
 * 안 되는 곳은 호출부에서 잡는다. DB 트랜잭션과 함께 쓸 때는 커밋이 끝난 뒤
 * 부른다 — 롤백돼도 메시지는 이미 나간다.
 */
@Injectable()
export class AlimtalkService {
  private readonly logger = new Logger(AlimtalkService.name);

  constructor(
    private readonly client: BizppurioClient,
    @Inject(BIZPPURIO_CONFIG)
    private readonly config: Pick<BizppurioConfig, 'account' | 'senderKey'>,
    private readonly prisma: PrismaService,
  ) {}

  async send(input: SendAlimtalkInput): Promise<AlimtalkSendResult> {
    const { templateCode } = input;
    const phone = input.to.replace(/\D/g, '');
    if (!MOBILE.test(phone))
      throw new Error(`휴대폰 번호가 아닙니다: ${maskPhone(phone)}`);

    const template = await findSendableTemplate(
      this.prisma,
      templateCode,
      'ALIMTALK',
    );
    // 본문은 로그에 남기지 않는다. 이름 · 초대 링크 같은 값이 들어간다.
    const { body } = renderTemplate(
      template,
      input.variables,
      input.maskedVariables,
    );

    const refKey = randomUUID().replace(/-/g, '').slice(0, 20);
    try {
      const response = await this.client.sendMessage({
        account: this.config.account,
        type: 'at',
        refkey: refKey,
        to: phone,
        content: {
          at: {
            senderkey: this.config.senderKey,
            // CHECK notification_templates_alimtalk_fields 가 ALIMTALK 행에 값을 보장한다.
            templatecode: template.kakaoTemplateCode as string,
            message: body,
          },
        },
      });
      this.logger.log(
        `alimtalk ACCEPTED template=${templateCode} refKey=${refKey} messageKey=${response.messagekey} to=${maskPhone(phone)}`,
      );
      return { refKey, messageKey: response.messagekey };
    } catch (e) {
      const { code, httpStatus } =
        e instanceof BizppurioError ? e : ({} as BizppurioError);
      // 네트워크 실패는 code 가 없어, 원인은 메시지로만 남는다.
      this.logger.warn(
        `alimtalk FAILED template=${templateCode} refKey=${refKey} code=${code} http=${httpStatus} to=${maskPhone(phone)}: ${(e as Error).message.slice(0, LOG_REASON_LENGTH)}`,
      );
      throw e;
    }
  }
}

/** 01012345678 → 010****5678 */
function maskPhone(phone: string): string {
  return phone.length < 8
    ? '***'
    : `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}
```

- [ ] **Step 4: 모듈 정리와 레지스트리 삭제**

`src/alimtalk/alimtalk.module.ts` 에서 `ALIMTALK_TEMPLATE_REGISTRY` · `ALIMTALK_TEMPLATES` import 와
`{ provide: ALIMTALK_TEMPLATE_REGISTRY, useValue: ALIMTALK_TEMPLATES },` 줄을 지우고, 모듈 위 주석의 마지막 줄에
`// PrismaService 는 전역 PrismaModule 에서 온다.` 를 더한다.

```bash
git rm src/alimtalk/alimtalk-templates.ts
grep -rn "alimtalk-templates\|ALIMTALK_TEMPLATE" src || echo "no references"
```
Expected: `no references`

- [ ] **Step 5: 통과 확인**

Run: `pnpm test alimtalk`
Expected: PASS — `alimtalk.service` 18 passed(it.each 펼침 포함), `bizppurio.client` · `bizppurio.config` 기존 테스트도 통과

- [ ] **Step 6: 커밋**

```bash
git add src/alimtalk
git commit -m "feat: 알림톡을 notification_templates 의 ALIMTALK 템플릿으로 발송"
```

---

### Task 4: 테이블 제안서 · okf · 전체 검증

**Files:**
- Create: `docs/plans/2026-10-07-alimtalk-send-logs-table.md`
- Modify: `okf/api/alimtalk.md`, `okf/api/mail.md`, `okf/log.md`

- [ ] **Step 1: 테이블 제안서**

`docs/plans/2026-10-07-alimtalk-send-logs-table.md` — front `docs/erd/README.md` 의 표 형식(키 · 속성 · 논리 타입 · 제안 컬럼 · 비고)에 맞춘다. 재영님께 그대로 넘길 수 있게 쓴다:

```markdown
# 알림톡 발송 이력 테이블 제안 (front 논리 ERD 반영 요청)

- 요청: 2026-10-07, api `snorlax` (PR #6)
- 근거: 메일은 `mail_send_logs` 가 있지만 알림톡은 발송 기록이 앱 로그 한 줄뿐이다. 기존
  `notification_deliveries` 는 `notification_recipients` 행에 묶여 있어 가입 초대처럼 계정이 없는
  사람에게 보내는 알림톡을 담지 못한다.
- api 쪽 설계: `docs/plans/2026-10-07-alimtalk-db-templates-design.md` 2단계

### 알림톡 발송 이력 `alimtalk_send_logs` · 이력

| 키 | 속성 | 논리 타입 | 제안 컬럼 | 비고 |
|---|---|---|---|---|
| PK | 알림톡 발송 이력 ID | id | `alimtalk_send_log_id` |  |
|  | 템플릿 코드 | text | `template_code` | 보낸 알림 템플릿 |
|  | 카카오 템플릿 코드 | text | `kakao_template_code` | 보낸 시점 값 — 템플릿 행은 고쳐질 수 있다 |
|  | 수신 번호 | text | `to_phone` | 숫자만, 01X 휴대폰 |
|  | 관련 업무 유형 | text | `related_type` | 선택 — 예 INVITATION |
|  | 관련 업무 ID | id | `related_id` | 선택 — 유형과 함께만 |
|  | 보낸 본문 | text | `body` | 호출부가 지정한 값은 ******** |
|  | 발송 결과 | enum | `result` | 성공·실패 (비즈뿌리오 접수 기준) |
|  | 실패 사유 | text | `failure_reason` | 비즈뿌리오 코드 · HTTP 상태 · 메시지 |
|  | 요청 키 | text | `ref_key` | 결과 리포트의 REFKEY |
|  | 메시지 키 | text | `message_key` | 비즈뿌리오가 붙인 키 |
| FK | 발송 관리자 | id | `sent_by` | 관리자가 대신 보냈을 때 |
|  | 발송 일시 | datetime | `sent_at` |  |

**관계**

- 관리자 계정 `1` — `N` 알림톡 발송 이력 · 발송

**물리 쪽에서 더할 것 (api `_model.py`)**

- `result` 는 기존 enum `dispatch_result`(SUCCEEDED · FAILED)
- CHECK `alimtalk_send_logs_to_phone_format`: `"to_phone" ~ '^01[0-9]{8,9}$'`
- CHECK `alimtalk_send_logs_related_pair`: `num_nonnulls("related_type", "related_id") <> 1`
- INDEX (`related_type`, `related_id`), INDEX (`to_phone`, `sent_at`)
- `is_deleted` 없음 — `_logs` 는 지우지 않는다
```

- [ ] **Step 2: okf/api/alimtalk.md 갱신**

- 프런트매터: `generated: { by: claude-code/opus-5.5, at: <UTC 지금> }`. `sources` 에서 `alimtalk-templates` 항목을 지우고, `alimtalk-service` · `alimtalk-module` 의 `last_modified` 를 지금으로, 새 항목 두 개를 더한다:
  ```yaml
  - id: notification-templates-render
    resource: ../../src/notification-templates/render-template.ts
    title: renderTemplate (shared by mail and alimtalk)
    last_modified: <UTC 지금>
  - id: notification-templates-find
    resource: ../../src/notification-templates/find-template.ts
    title: findSendableTemplate (missing / off / wrong channel)
    last_modified: <UTC 지금>
  ```
- `# Using it` 의 예시를 새 호출 모양으로 바꾼다:
  ```ts
  await alimtalk.send({
    templateCode: 'TALK_STAFF_INVITATION',
    to: invitation.phone,
    variables: { 근무지: store.name, 링크: joinUrl },
    maskedVariables: ['링크'],
  });
  ```
- `# Templates live in notification_templates; code only seeds them` 절의 「**Decided 2026-10-07 (재영), not yet built.**」 를 「Decided 2026-10-07 (재영), built 2026-10-07.」 로 바꾸고, `## How the code works today` 하위 절을 다음 내용으로 교체한다: 레지스트리 · 컴파일 단계 변수 타입 · 제목(강조 표기형)이 없어졌다, 비즈뿌리오 `templatecode` 는 행의 `kakao_template_code`, 렌더 · 조회는 `src/notification-templates/` 를 메일과 같이 쓴다, 본문은 이스케이프하지 않는다, 템플릿 없음 · 꺼짐 · 채널 다름은 이유를 나눠 던진다.
- `# Not built` 에서 「Template bodies are not yet in the registry … Reading the body from notification_templates at send time (above) is also not built.」 를 지우고, 「a send-log table」 을 「a send-log table (`alimtalk_send_logs`, proposed — waiting for the front logical ERD; `docs/plans/2026-10-07-alimtalk-send-logs-table.md`)」 로 바꾼다.

- [ ] **Step 3: okf/api/mail.md 갱신**

- `sources` 의 `mail-render` 항목 `resource` 를 `../../src/notification-templates/render-template.ts`, `title` 을 `renderTemplate (shared with alimtalk; escapeBody for mail)`, `last_modified` 를 지금으로. `mail-service` 의 `last_modified` 와 `generated.at` 도 지금으로.
- 본문에 한 줄: 렌더와 템플릿 조회는 `src/notification-templates/` 에 있고 알림톡과 같이 쓴다. 메일은 `escapeBody: true` 로 부른다.
- 실패 표의 첫 행 「template missing / off / not EMAIL / no title」 은 그대로 둔다(메시지만 나뉘었다).

- [ ] **Step 4: okf/log.md**

`## 2026-10-07` 바로 아래 첫 줄:

```
* **Update**: [Kakao Alimtalk (Bizppurio)](/api/alimtalk.md) — 알림톡이 `notification_templates` 의 ALIMTALK 행에서 문구를 읽고 `kakao_template_code` 로 보낸다. 코드 레지스트리 · 컴파일 단계 변수 타입 · 제목을 없앴다. 렌더와 조회를 `src/notification-templates/` 로 옮겨 [Mail (Gmail SMTP)](/api/mail.md) 과 같이 쓴다. 발송 이력 테이블 `alimtalk_send_logs` 는 front 논리 ERD 반영을 기다린다(제안서 `docs/plans/2026-10-07-alimtalk-send-logs-table.md`).
```

- [ ] **Step 5: 전체 검증**

Run: `pnpm lint && pnpm exec tsc --noEmit -p tsconfig.json && pnpm build && pnpm test && pnpm test:e2e`
Expected: lint 오류 0, tsc 오류 0, build 성공, unit failed 0, e2e failed 0. `pnpm lint` 는 `--fix` 로 파일을 고치므로 끝난 뒤 `git status` 로 바뀐 파일을 확인한다.

- [ ] **Step 6: 커밋**

```bash
git add docs/plans/2026-10-07-alimtalk-send-logs-table.md okf/api/alimtalk.md okf/api/mail.md okf/log.md
git commit -m "docs: 알림톡 DB 템플릿 전환을 okf 에 반영하고 발송 이력 테이블 제안서 추가"
```

---

## Self-Review 결과

- Spec 대비: 공용 렌더(Task 1), 공용 조회(Task 2), 메일 import 변경 · 동작 그대로(Task 1·2 의 무수정 통과), 알림톡 전환 · 레지스트리 · 제목 제거(Task 3), 테이블 제안서 · okf(Task 4) — 1단계 항목 빠짐 없음. 2단계는 계획 범위 밖.
- 이름 일관성: `renderTemplate` · `TemplateSource` · `TemplateVariable` · `RenderedTemplate`(`subject` · `body` · `maskedSubject` · `maskedBody`) · `MASK` · `findSendableTemplate` · `SendableTemplate`(`kakaoTemplateCode`) · `SendAlimtalkInput` · `AlimtalkSendResult` 를 모든 Task 에서 같은 철자로 쓴다.
- 스펙과 다른 점: spec 의 `findSendableTemplate` 반환은 `NotificationTemplate` 이었으나, 호출부마다 `variables` 를 캐스팅하지 않도록 렌더 입력 모양(`SendableTemplate`)으로 돌려준다. 오류 메시지를 없음 · 비활성 · 채널 다름으로 나눴다(앞선 리뷰의 제안).
