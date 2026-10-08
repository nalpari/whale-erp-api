# 메일 발송 공통 기능 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `MailService.send()` 하나로 `notification_templates` 의 EMAIL 템플릿(HTML)을 채워 Gmail SMTP 로 보내고, 결과를 `mail_send_logs` 에 남긴다.

**Architecture:** `src/mail/` 모듈 하나. 설정 읽기(`mail.config.ts`), 순수 렌더 함수(`render-template.ts`), 조회·발송·이력을 묶는 `MailService`, nodemailer transport 를 만드는 `MailModule`. `AppModule` 에는 넣지 않는다.

**Tech Stack:** NestJS 11, Prisma 7 (`PrismaService` 는 `@Global` `PrismaModule`), nodemailer 10 (타입 내장), Jest + ts-jest.

**Spec:** `docs/plans/2026-10-07-mail-sending-design.md`

## Global Constraints

- 발송: `smtp.gmail.com:465`, `secure: true`, `connectionTimeout` · `socketTimeout` 30_000ms. 발신 표시 이름 `WHALE ERP`, 주소 `MAIL_USERNAME`.
- 환경변수 `MAIL_USERNAME`, `MAIL_PASSWORD` — 비면 기동 단계에서 던진다. `.env.example` 에는 키만.
- 템플릿 `body` 는 완성된 HTML. 감싸는 틀 없음, HTML 파트 하나만 보낸다. `isButtonLink` 는 발송 코드가 읽지 않는다.
- 본문에 넣는 값은 HTML 이스케이프(`& < > " '`), 제목 값은 그대로.
- 이력: 발송 시도마다 한 행. `mail_type_code = templateCode`, `subject`·`body` 는 가린 값, `result` 는 `SUCCEEDED` / `FAILED`. 가림 문자열은 `********`.
- 발송 전 검증 실패는 예외, SMTP 호출·이력 없음. SMTP 실패는 `FAILED` 기록 후 원래 예외를 다시 던진다. 이력 INSERT 실패는 `logger.error` 만, 던지지 않는다.
- 재시도 없음. 애플리케이션 로그에 본문·원래 주소를 남기지 않는다(가린 주소 `h***@example.com`).
- 예외는 Nest HTTP 예외가 아닌 `Error` — 알림톡과 같이 호출부가 처리한다.
- 테스트 실행: `pnpm test <파일 이름 일부>` (`--` 쓰지 않는다). 성공 여부는 exit code 가 아니라 passed/failed 개수로 본다.
- 커밋 메시지: 영어 type 접두 + 한글 subject. 끝에 다음 두 줄:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01RbA5Wdg9f3TBLB2rwoVAmD`

## Review Focus

1. 값 안에 `#{다른변수}` 가 들어 있어도 다시 치환하지 않는다(한 번에 치환) — Task 2 테스트.
2. `href="#{링크}"` 속성 안에 들어가는 값의 `"` 는 `&quot;` 로 이스케이프돼 속성을 깨지 못한다 — Task 2 테스트.
3. 받는 주소가 `"이름" <a@b.com>` · `a@b.com, c@d.com` · `a@b.com;c@d.com` · 공백 포함이면 거부한다 — Task 3 테스트.
4. SMTP 가 `code`·`responseCode` 없는 오류를 던져도 `FAILED` 행과 `failure_reason` 이 남는다 — Task 3 테스트.
5. 선택 변수를 넘기지 않았는데 본문에 `#{선택변수}` 가 있으면 빈 문자열로, 선언되지 않은 `#{toString}` 같은 자리는 상속 속성을 값으로 쓰지 않고 던진다 — Task 2 테스트.

---

## File Structure

| 파일 | 책임 |
|---|---|
| `src/mail/mail.config.ts` | `MAIL_*` 읽기·검증, `MAIL_CONFIG` 토큰 |
| `src/mail/render-template.ts` | 변수 검증 + `#{}` 치환 + HTML 이스케이프 + 가림본 생성 (순수) |
| `src/mail/mail.service.ts` | 주소 검증 → 템플릿 조회 → 렌더 → 발송 → 이력, `MAIL_TRANSPORT` 토큰 |
| `src/mail/mail.module.ts` | config · transport 프로바이더, `MailService` export |
| `okf/api/mail.md` | 개념 문서 |

---

### Task 1: 메일 설정 읽기 + nodemailer 의존성

**Files:**
- Create: `src/mail/mail.config.ts`
- Test: `src/mail/mail.config.spec.ts`
- Modify: `package.json`, `pnpm-lock.yaml` (nodemailer), `.env.example`

**Interfaces:**
- Produces: `MAIL_CONFIG: symbol`, `type MailConfig = { username: string; password: string }`, `readMailConfig(get: (key: string) => string | undefined): MailConfig`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/mail/mail.config.spec.ts`:

```ts
import { readMailConfig } from './mail.config';

describe('readMailConfig', () => {
  const env: Record<string, string> = {
    MAIL_USERNAME: 'noreply@whale.test',
    MAIL_PASSWORD: 'abcd efgh ijkl mnop',
  };
  const read = (overrides: Record<string, string | undefined> = {}) =>
    readMailConfig((key) => ({ ...env, ...overrides })[key]);

  it('두 값을 읽는다. 앱 비밀번호 가운데 공백은 그대로 둔다', () => {
    expect(read()).toEqual({
      username: 'noreply@whale.test',
      password: 'abcd efgh ijkl mnop',
    });
  });

  it.each(['MAIL_USERNAME', 'MAIL_PASSWORD'])(
    '%s 가 비면 이름을 담아 던진다',
    (key) => {
      expect(() => read({ [key]: '  ' })).toThrow(key);
      expect(() => read({ [key]: undefined })).toThrow(key);
    },
  );
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm test mail.config`
Expected: FAIL — `Cannot find module './mail.config'`

- [ ] **Step 3: 구현**

`src/mail/mail.config.ts`:

```ts
export const MAIL_CONFIG = Symbol('MAIL_CONFIG');

export type MailConfig = {
  /** Gmail 주소. 발신 주소로도 쓴다 */
  username: string;
  /** Gmail 앱 비밀번호(계정 비밀번호가 아니다) */
  password: string;
};

const KEYS = {
  username: 'MAIL_USERNAME',
  password: 'MAIL_PASSWORD',
} as const;

/**
 * 메일 설정을 읽는다. 기동 단계에서 부르며 하나라도 비면 던진다. 그대로 떠
 * 버리면 첫 발송 때에야 인증 오류로 드러난다.
 */
export function readMailConfig(
  get: (key: string) => string | undefined,
): MailConfig {
  const read = (key: string) => {
    const value = get(key)?.trim();
    if (!value)
      throw new Error(`${key} 가 비어 있습니다. .env.<APP_ENV> 를 확인하세요.`);
    return value;
  };
  return { username: read(KEYS.username), password: read(KEYS.password) };
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm test mail.config`
Expected: PASS, 3 passed

- [ ] **Step 5: 의존성과 .env.example**

Run: `pnpm add nodemailer`
Expected: `package.json` dependencies 에 `"nodemailer": "^10.…"`. nodemailer 10 은 타입을 내장하므로 `@types/nodemailer` 는 넣지 않는다.

`.env.example` 끝에 추가:

```
# Gmail SMTP 메일 발송. MailModule 을 import 하는 순간 둘 다 필요하고,
# 하나라도 비면 부팅 단계에서 멈춘다. 비밀번호는 Google 계정의 앱 비밀번호다.
MAIL_USERNAME=
MAIL_PASSWORD=
```

- [ ] **Step 6: 커밋**

```bash
git add src/mail/mail.config.ts src/mail/mail.config.spec.ts package.json pnpm-lock.yaml .env.example
git commit -m "feat: 메일 설정 읽기와 nodemailer 의존성 추가"
```

---

### Task 2: 템플릿 렌더 (순수 함수)

**Files:**
- Create: `src/mail/render-template.ts`
- Test: `src/mail/render-template.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  type TemplateVariable = { name: string; isRequired?: boolean };
  type MailTemplateSource = {
    templateCode: string;
    title: string;
    body: string;
    variables: TemplateVariable[];
  };
  type RenderedMail = {
    subject: string; html: string;          // 보낼 것
    maskedSubject: string; maskedHtml: string; // 이력에 남길 것
  };
  const MASK = '********';
  function renderMail(
    template: MailTemplateSource,
    values: Record<string, string>,
    maskedVariables?: readonly string[],
  ): RenderedMail;
  ```

규칙:
- `values` 에 템플릿 `variables` 에 없는 이름이 있으면 던진다.
- `maskedVariables` 에 템플릿 `variables` 에 없는 이름이 있으면 던진다.
- `isRequired` 변수가 `values` 에 없으면(자기 속성으로) 던진다. 빈 문자열은 값으로 본다.
- `#{이름}` 자리: `values` 에 자기 속성으로 있으면 그 값, 선언된 선택 변수면 `''`, 선언되지 않았으면 던진다.
- 한 번에 치환한다(값 안의 `#{…}` 는 그대로).
- 본문은 이스케이프, 제목은 그대로. 가림본은 가릴 변수 값만 `MASK` 로 바꿔 같은 규칙으로 렌더.
- 오류 메시지에 템플릿 코드와 변수 이름은 넣되 값은 넣지 않는다.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/mail/render-template.spec.ts`:

```ts
import { MASK, type MailTemplateSource, renderMail } from './render-template';

describe('renderMail', () => {
  const template: MailTemplateSource = {
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

  it('제목과 본문의 자리를 모두 치환한다', () => {
    const mail = renderMail(template, values);

    expect(mail.subject).toBe('[WHALE ERP] 이서준 님 임시 비밀번호');
    expect(mail.html).toBe(
      '<p>이서준 님, 이서준 님</p><p>x8Rk-2mPq</p><a href="https://erp.whale.test/login">바로가기</a>',
    );
  });

  it('본문 값은 HTML 이스케이프하고 제목 값은 그대로 둔다', () => {
    const mail = renderMail(template, { ...values, 관리자이름: `<b>"O'Neil" & co</b>` });

    expect(mail.subject).toBe(`[WHALE ERP] <b>"O'Neil" & co</b> 님 임시 비밀번호`);
    expect(mail.html).toContain(
      '<p>&lt;b&gt;&quot;O&#39;Neil&quot; &amp; co&lt;/b&gt; 님',
    );
  });

  it('속성 안에 들어가는 값의 따옴표가 속성을 깨지 못한다', () => {
    const mail = renderMail(template, {
      ...values,
      링크: 'https://x.test/" onclick="alert(1)',
    });

    expect(mail.html).toContain(
      '<a href="https://x.test/&quot; onclick=&quot;alert(1)">',
    );
  });

  it('값 안의 #{...} 는 다시 치환하지 않는다', () => {
    const mail = renderMail(template, { ...values, 관리자이름: '#{임시비밀번호}' });

    expect(mail.html).toContain('<p>#{임시비밀번호} 님');
    expect(mail.subject).toBe('[WHALE ERP] #{임시비밀번호} 님 임시 비밀번호');
  });

  it('넘기지 않은 선택 변수는 빈 문자열이고, 넘기면 값이 들어간다', () => {
    expect(renderMail(template, values).html.endsWith('</a>')).toBe(true);
    expect(
      renderMail(template, { ...values, 추신: '감사합니다' }).html.endsWith(
        '</a>감사합니다',
      ),
    ).toBe(true);
  });

  it('필수 변수가 빠지면 이름을 담아 던진다. 빈 문자열은 값이다', () => {
    // 구조 분해로 빼면 버린 변수가 no-unused-vars 에 걸린다.
    const rest = { 관리자이름: values.관리자이름, 링크: values.링크 };

    expect(() => renderMail(template, rest)).toThrow('임시비밀번호');
    expect(() => renderMail(template, { ...values, 임시비밀번호: '' })).not.toThrow();
  });

  it('템플릿에 없는 변수를 넘기면 던진다', () => {
    expect(() => renderMail(template, { ...values, 오타: 'x' })).toThrow('오타');
  });

  it('선언되지 않은 자리는 상속 속성을 값으로 쓰지 않고 던진다', () => {
    const broken = { ...template, body: '<p>#{toString}</p>' };

    expect(() => renderMail(broken, values)).toThrow('toString');
  });

  it('가림본은 지정한 변수만 MASK 로 바꾸고, 제목에도 적용한다', () => {
    const mail = renderMail(template, values, ['임시비밀번호', '관리자이름']);

    expect(mail.html).toContain('<p>x8Rk-2mPq</p>');
    expect(mail.maskedHtml).toBe(
      `<p>${MASK} 님, ${MASK} 님</p><p>${MASK}</p><a href="https://erp.whale.test/login">바로가기</a>`,
    );
    expect(mail.maskedSubject).toBe(`[WHALE ERP] ${MASK} 님 임시 비밀번호`);
  });

  it('가리지 않으면 가림본은 보낼 것과 같다', () => {
    const mail = renderMail(template, values);

    expect(mail.maskedHtml).toBe(mail.html);
    expect(mail.maskedSubject).toBe(mail.subject);
  });

  it('템플릿에 없는 가림 이름은 던진다 — 오타로 평문이 남지 않게', () => {
    expect(() => renderMail(template, values, ['임시비번'])).toThrow('임시비번');
  });

  it('오류 메시지에 값은 담지 않는다', () => {
    const run = () => renderMail(template, { ...values, 오타: 'secret-value' });

    expect(run).toThrow('오타');
    expect(run).not.toThrow('secret-value');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm test render-template`
Expected: FAIL — `Cannot find module './render-template'`

- [ ] **Step 3: 구현**

`src/mail/render-template.ts`:

```ts
export type TemplateVariable = { name: string; isRequired?: boolean };

export type MailTemplateSource = {
  templateCode: string;
  title: string;
  body: string;
  variables: TemplateVariable[];
};

export type RenderedMail = {
  subject: string;
  html: string;
  /** mail_send_logs 에 남길 제목. 가릴 변수 값이 MASK 로 바뀌어 있다 */
  maskedSubject: string;
  /** mail_send_logs 에 남길 본문 */
  maskedHtml: string;
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
 * 메일 템플릿의 `#{변수}` 를 채운다. 본문은 완성된 HTML 이라 값을 이스케이프해
 * 넣고, 제목은 메일 헤더라 그대로 넣는다. 한 번에 치환하므로 값 안의 `#{...}` 는
 * 다시 치환하지 않는다.
 *
 * 이력용 가림본을 같은 규칙으로 함께 만든다. 템플릿에 없는 변수 이름은 넘긴
 * 값이든 가림 이름이든 던진다 — 가림 이름의 오타가 조용히 지나가면 비밀번호가
 * 이력에 평문으로 남는다. 오류 메시지에 값은 담지 않는다.
 */
export function renderMail(
  template: MailTemplateSource,
  values: Record<string, string>,
  maskedVariables: readonly string[] = [],
): RenderedMail {
  const { templateCode: code } = template;
  const declared = new Map(template.variables.map((v) => [v.name, v]));

  const unknown = [...Object.keys(values), ...maskedVariables].filter(
    (name) => !declared.has(name),
  );
  if (unknown.length)
    throw new Error(
      `메일 ${code} 템플릿에 없는 변수입니다: ${unknown.join(', ')}`,
    );
  const missing = template.variables
    .filter((v) => v.isRequired && typeof own(values, v.name) !== 'string')
    .map((v) => v.name);
  if (missing.length)
    throw new Error(`메일 ${code} 필수 변수가 비었습니다: ${missing.join(', ')}`);

  const masked = { ...values };
  for (const name of maskedVariables) masked[name] = MASK;

  const fill = (text: string, from: Record<string, string>, escape: boolean) =>
    text.replace(PLACEHOLDER, (_, name: string) => {
      if (!declared.has(name))
        throw new Error(`메일 ${code} 템플릿에 선언되지 않은 자리입니다: ${name}`);
      const value = own(from, name) ?? '';
      return escape ? escapeHtml(value) : value;
    });

  return {
    subject: fill(template.title, values, false),
    html: fill(template.body, values, true),
    maskedSubject: fill(template.title, masked, false),
    maskedHtml: fill(template.body, masked, true),
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

- [ ] **Step 4: 통과 확인**

Run: `pnpm test render-template`
Expected: PASS, 12 passed

- [ ] **Step 5: 커밋**

```bash
git add src/mail/render-template.ts src/mail/render-template.spec.ts
git commit -m "feat: 메일 템플릿 렌더(치환 · HTML 이스케이프 · 이력용 가림)"
```

---

### Task 3: MailService — 조회 · 발송 · 이력

**Files:**
- Create: `src/mail/mail.service.ts`
- Test: `src/mail/mail.service.spec.ts`

**Interfaces:**
- Consumes: `MAIL_CONFIG`, `MailConfig` (Task 1), `renderMail`, `MailTemplateSource`, `TemplateVariable`, `MASK` (Task 2), `PrismaService` (`src/prisma/prisma.service.ts`)
- Produces:
  ```ts
  const MAIL_TRANSPORT: symbol;
  type SendMailInput = {
    templateCode: string;
    to: string;
    variables: Record<string, string>;
    maskedVariables?: readonly string[];
    adminAccountId?: number;
    sentBy?: number;
  };
  type MailSendResult = { messageId: string };
  class MailService { send(input: SendMailInput): Promise<MailSendResult> }
  ```
  생성자 의존: `MAIL_TRANSPORT` → `Pick<Transporter, 'sendMail'>`, `MAIL_CONFIG` → `Pick<MailConfig, 'username'>`, `PrismaService`.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/mail/mail.service.spec.ts`:

```ts
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { MAIL_CONFIG } from './mail.config';
import { MAIL_TRANSPORT, MailService } from './mail.service';
import { MASK } from './render-template';

describe('MailService', () => {
  let service: MailService;
  let transport: { sendMail: jest.Mock };
  let prisma: {
    notificationTemplate: { findUnique: jest.Mock };
    mailSendLog: { create: jest.Mock };
  };
  let logs: string[];

  const template = {
    templateCode: 'EMAIL_TEMP_PASSWORD',
    channel: 'EMAIL',
    isActive: true,
    title: '[WHALE ERP] 임시 비밀번호',
    body: '<p>#{관리자이름} 님</p><p>#{임시비밀번호}</p>',
    variables: [
      { name: '관리자이름', isRequired: true },
      { name: '임시비밀번호', isRequired: true },
    ],
  };
  const input = {
    templateCode: 'EMAIL_TEMP_PASSWORD',
    to: 'hong@example.com',
    variables: { 관리자이름: '이서준', 임시비밀번호: 'x8Rk-2mPq' },
    maskedVariables: ['임시비밀번호'],
    adminAccountId: 12,
    sentBy: 3,
  };

  beforeEach(async () => {
    transport = {
      sendMail: jest.fn().mockResolvedValue({ messageId: '<abc@gmail.com>' }),
    };
    prisma = {
      notificationTemplate: { findUnique: jest.fn().mockResolvedValue(template) },
      mailSendLog: { create: jest.fn().mockResolvedValue({}) },
    };
    logs = [];
    for (const level of ['log', 'warn', 'error'] as const)
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((message: string) => void logs.push(message));

    const module = await Test.createTestingModule({
      providers: [
        MailService,
        { provide: MAIL_TRANSPORT, useValue: transport },
        { provide: MAIL_CONFIG, useValue: { username: 'noreply@whale.test' } },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(MailService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('템플릿 코드로 조회해 HTML 로 보내고 messageId 를 돌려준다', async () => {
    await expect(service.send(input)).resolves.toEqual({
      messageId: '<abc@gmail.com>',
    });

    expect(prisma.notificationTemplate.findUnique).toHaveBeenCalledWith({
      where: { templateCode: 'EMAIL_TEMP_PASSWORD' },
    });
    expect(transport.sendMail).toHaveBeenCalledWith({
      from: { name: 'WHALE ERP', address: 'noreply@whale.test' },
      to: 'hong@example.com',
      subject: '[WHALE ERP] 임시 비밀번호',
      html: '<p>이서준 님</p><p>x8Rk-2mPq</p>',
    });
  });

  it('성공하면 가린 본문으로 SUCCEEDED 이력을 남긴다', async () => {
    await service.send(input);

    expect(prisma.mailSendLog.create).toHaveBeenCalledWith({
      data: {
        mailTypeCode: 'EMAIL_TEMP_PASSWORD',
        adminAccountId: 12,
        fromEmail: 'noreply@whale.test',
        toEmail: 'hong@example.com',
        subject: '[WHALE ERP] 임시 비밀번호',
        body: `<p>이서준 님</p><p>${MASK}</p>`,
        result: 'SUCCEEDED',
        failureReason: null,
        sentBy: 3,
      },
    });
  });

  it('수신 관리자 · 처리자를 넘기지 않으면 NULL 로 남긴다', async () => {
    await service.send({
      templateCode: input.templateCode,
      to: input.to,
      variables: input.variables,
    });

    expect(prisma.mailSendLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ adminAccountId: null, sentBy: null }),
    });
  });

  it('SMTP 가 실패하면 FAILED 이력을 남기고 원래 예외를 다시 던진다', async () => {
    const error = Object.assign(new Error('Invalid login'), {
      code: 'EAUTH',
      responseCode: 535,
    });
    transport.sendMail.mockRejectedValue(error);

    await expect(service.send(input)).rejects.toBe(error);
    expect(prisma.mailSendLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        result: 'FAILED',
        failureReason: 'code=EAUTH response=535: Invalid login',
        body: `<p>이서준 님</p><p>${MASK}</p>`,
      }),
    });
  });

  it('code 가 없는 SMTP 오류도 FAILED 이력을 남긴다', async () => {
    transport.sendMail.mockRejectedValue(new Error('socket hang up'));

    await expect(service.send(input)).rejects.toThrow('socket hang up');
    expect(prisma.mailSendLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        result: 'FAILED',
        failureReason: 'code=undefined response=undefined: socket hang up',
      }),
    });
  });

  it('보낸 뒤 이력 INSERT 가 실패해도 던지지 않는다 — 다시 보내게 하지 않는다', async () => {
    prisma.mailSendLog.create.mockRejectedValue(new Error('db down'));

    await expect(service.send(input)).resolves.toEqual({
      messageId: '<abc@gmail.com>',
    });
    expect(logs.some((m) => m.includes('db down'))).toBe(true);
  });

  it('SMTP 실패 뒤 이력 INSERT 도 실패하면 SMTP 예외를 던진다', async () => {
    const error = new Error('Invalid login');
    transport.sendMail.mockRejectedValue(error);
    prisma.mailSendLog.create.mockRejectedValue(new Error('db down'));

    await expect(service.send(input)).rejects.toBe(error);
  });

  it.each([
    ['템플릿이 없다', null],
    ['사용 안 함', { ...template, isActive: false }],
    ['메일 채널이 아니다', { ...template, channel: 'PUSH' }],
  ])('%s 면 보내지도 기록하지도 않고 던진다', async (_, row) => {
    prisma.notificationTemplate.findUnique.mockResolvedValue(row);

    await expect(service.send(input)).rejects.toThrow('EMAIL_TEMP_PASSWORD');
    expect(transport.sendMail).not.toHaveBeenCalled();
    expect(prisma.mailSendLog.create).not.toHaveBeenCalled();
  });

  it('필수 변수가 빠지면 보내지도 기록하지도 않고 던진다', async () => {
    await expect(
      service.send({ ...input, variables: { 관리자이름: '이서준' } }),
    ).rejects.toThrow('임시비밀번호');
    expect(transport.sendMail).not.toHaveBeenCalled();
    expect(prisma.mailSendLog.create).not.toHaveBeenCalled();
  });

  it.each([
    'hong',
    'hong@example',
    '"홍길동" <hong@example.com>',
    'hong@example.com, kim@example.com',
    'hong@example.com;kim@example.com',
    'hong @example.com',
    'hong@example.com (홍길동)',
  ])('주소 하나가 아니면(%s) 조회도 하지 않고 던진다', async (to) => {
    await expect(service.send({ ...input, to })).rejects.toThrow('메일 주소');
    expect(prisma.notificationTemplate.findUnique).not.toHaveBeenCalled();
    expect(transport.sendMail).not.toHaveBeenCalled();
    expect(prisma.mailSendLog.create).not.toHaveBeenCalled();
  });

  it('로그에 본문 값과 원래 주소를 남기지 않는다', async () => {
    await service.send(input);
    transport.sendMail.mockRejectedValue(new Error('timeout'));
    await service.send(input).catch(() => undefined);

    expect(logs.length).toBeGreaterThan(0);
    for (const message of logs) {
      expect(message).not.toContain('x8Rk-2mPq');
      expect(message).not.toContain('hong@example.com');
    }
    expect(logs.some((m) => m.includes('h***@example.com'))).toBe(true);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm test mail.service`
Expected: FAIL — `Cannot find module './mail.service'`

- [ ] **Step 3: 구현**

`src/mail/mail.service.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Transporter } from 'nodemailer';
import { PrismaService } from '../prisma/prisma.service';
import { MAIL_CONFIG, type MailConfig } from './mail.config';
import {
  type RenderedMail,
  type TemplateVariable,
  renderMail,
} from './render-template';

export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');

export type SendMailInput = {
  /** notification_templates.template_code. EMAIL 채널이어야 한다 */
  templateCode: string;
  to: string;
  /** 템플릿 variables 의 이름 그대로 */
  variables: Record<string, string>;
  /** mail_send_logs 에 ******** 로 남길 변수 — 임시 비밀번호 · 핀 등 */
  maskedVariables?: readonly string[];
  /** 받는 사람이 관리자 계정일 때 */
  adminAccountId?: number;
  /** 관리자가 대신 보냈을 때. 본인 요청이면 비운다 */
  sentBy?: number;
};

export type MailSendResult = {
  /** SMTP 서버가 받은 메시지의 Message-ID */
  messageId: string;
};

const FROM_NAME = 'WHALE ERP';
// 주소 하나만 받는다. 쉼표·세미콜론이 있으면 nodemailer 가 받는 사람을 여럿으로
// 나누고, 꺾쇠·따옴표는 표시 이름으로 읽고, 콜론·괄호·역슬래시는 그룹·주석
// 문법이라 검사한 주소와 실제 받는 주소가 달라진다.
const EMAIL = /^[^\s@,;<>"():\\]+@[^\s@,;<>"():\\]+\.[^\s@,;<>"():\\]+$/;

/**
 * 메일 발송의 공통 진입점. 각 도메인은 이 서비스만 주입받아 쓴다.
 *
 * `notification_templates` 의 EMAIL 템플릿(완성된 HTML)을 채워 Gmail SMTP 로 보내고,
 * 시도마다 `mail_send_logs` 에 한 행을 남긴다. 보내기 전 검증에 걸리면 보낸 것이
 * 없으므로 기록도 없다.
 *
 * SMTP 서버가 받을 때까지만 책임진다. 타임아웃은 「안 갔다」가 아니다 — 본문을
 * 보낸 뒤 끊겼으면 Gmail 이 이미 받았을 수 있어 자동으로 다시 보내지 않는다.
 * 실패는 던지므로, 발송이 본 작업을 막으면 안 되는 곳은 호출부에서 잡는다.
 * DB 트랜잭션과 함께 쓸 때는 커밋이 끝난 뒤 부른다 — 롤백돼도 메일은 이미 나간다.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    @Inject(MAIL_TRANSPORT)
    private readonly transport: Pick<Transporter, 'sendMail'>,
    @Inject(MAIL_CONFIG)
    private readonly config: Pick<MailConfig, 'username'>,
    private readonly prisma: PrismaService,
  ) {}

  async send(input: SendMailInput): Promise<MailSendResult> {
    const { templateCode, to } = input;
    if (!EMAIL.test(to))
      throw new Error(`메일 주소가 아닙니다: ${maskEmail(to)}`);

    const template = await this.prisma.notificationTemplate.findUnique({
      where: { templateCode },
    });
    if (
      !template ||
      !template.isActive ||
      template.channel !== 'EMAIL' ||
      template.title === null
    )
      throw new Error(`메일 템플릿 ${templateCode} 이(가) 없거나 쓸 수 없습니다`);

    // 본문은 로그에 남기지 않는다. 이름·임시 비밀번호 같은 개인정보가 들어간다.
    const mail = renderMail(
      {
        templateCode,
        title: template.title,
        body: template.body,
        // CHECK notification_templates_variables_array 가 배열임을 보장한다.
        variables: template.variables as TemplateVariable[],
      },
      input.variables,
      input.maskedVariables,
    );

    let messageId: string;
    try {
      const info = (await this.transport.sendMail({
        from: { name: FROM_NAME, address: this.config.username },
        to,
        subject: mail.subject,
        html: mail.html,
      })) as { messageId: string };
      messageId = info.messageId;
    } catch (e) {
      const { code, responseCode } = e as {
        code?: string;
        responseCode?: number;
      };
      const reason = `code=${code} response=${responseCode}: ${(e as Error).message}`;
      this.logger.warn(
        `mail FAILED template=${templateCode} to=${maskEmail(to)} ${reason}`,
      );
      await this.record(input, mail, reason);
      throw e;
    }

    this.logger.log(
      `mail ACCEPTED template=${templateCode} messageId=${messageId} to=${maskEmail(to)}`,
    );
    await this.record(input, mail, null);
    return { messageId };
  }

  /**
   * 이력 한 행. 실패해도 던지지 않는다 — 메일은 이미 나갔거나 SMTP 예외를 던질
   * 참이고, 여기서 던지면 호출부가 실패로 보고 다시 보낼 수 있다.
   */
  private async record(
    input: SendMailInput,
    mail: RenderedMail,
    failureReason: string | null,
  ): Promise<void> {
    try {
      await this.prisma.mailSendLog.create({
        data: {
          mailTypeCode: input.templateCode,
          adminAccountId: input.adminAccountId ?? null,
          fromEmail: this.config.username,
          toEmail: input.to,
          subject: mail.maskedSubject,
          body: mail.maskedHtml,
          result: failureReason === null ? 'SUCCEEDED' : 'FAILED',
          failureReason,
          sentBy: input.sentBy ?? null,
        },
      });
    } catch (e) {
      this.logger.error(
        `mail_send_logs INSERT FAILED template=${input.templateCode} to=${maskEmail(input.to)}: ${(e as Error).message}`,
      );
    }
  }
}

/** hong@example.com → h***@example.com */
function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 1 ? '***' : `${email[0]}***${email.slice(at)}`;
}
```

주의: SMTP 오류 메시지(`reason`)에 받는 주소가 들어 있을 수 있다(예: `550 … hong@example.com`). 로그 테스트가 이를 잡으면 `reason` 을 로그에 쓸 때 `to` 를 `maskEmail(to)` 로 바꿔 쓴다:
`reason.split(to).join(maskEmail(to))`. `failure_reason` 컬럼에는 원문을 넣는다(같은 행에 `to_email` 이 이미 있다).

- [ ] **Step 4: 통과 확인**

Run: `pnpm test mail.service`
Expected: PASS, 19 passed (it.each 펼침 포함)

- [ ] **Step 5: 커밋**

```bash
git add src/mail/mail.service.ts src/mail/mail.service.spec.ts
git commit -m "feat: MailService — 템플릿 조회 · Gmail 발송 · mail_send_logs 기록"
```

---

### Task 4: MailModule 연결 · 빌드 확인 · okf 문서

**Files:**
- Create: `src/mail/mail.module.ts`
- Create: `okf/api/mail.md`
- Modify: `okf/index.md` (API 목록에 한 줄), `okf/log.md` (`## 2026-10-07` 아래 맨 위에 한 줄)

**Interfaces:**
- Consumes: `MAIL_CONFIG`, `MailConfig`, `readMailConfig` (Task 1), `MAIL_TRANSPORT`, `MailService` (Task 3)
- Produces: `MailModule` (exports `MailService`)

모듈 배선은 테스트를 따로 두지 않는다(CLAUDE.md TDD 범위 밖). 대신 빌드와 실제 DI 해석을 한 번 확인한다.

- [ ] **Step 1: 모듈 작성**

`src/mail/mail.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport } from 'nodemailer';
import { MAIL_CONFIG, type MailConfig, readMailConfig } from './mail.config';
import { MAIL_TRANSPORT, MailService } from './mail.service';

// 기본값은 연결 2분, 소켓 10분이라 Gmail 이 멈추면 호출부도 그만큼 묶인다.
const TIMEOUT_MS = 30_000;

// 메일을 보내는 모듈이 import 한다. import 되는 순간 MAIL_* 를 읽어 하나라도
// 비면 기동을 멈추므로, 쓰는 곳이 없는 지금은 AppModule 에 넣지 않는다.
// PrismaService 는 전역 PrismaModule 에서 온다.
@Module({
  providers: [
    {
      provide: MAIL_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        readMailConfig((key) => config.get<string>(key)),
    },
    {
      provide: MAIL_TRANSPORT,
      inject: [MAIL_CONFIG],
      // 465 는 처음부터 TLS 다. 587(STARTTLS)과 달리 평문으로 시작하지 않는다.
      useFactory: (config: MailConfig) =>
        createTransport({
          host: 'smtp.gmail.com',
          port: 465,
          secure: true,
          auth: { user: config.username, pass: config.password },
          connectionTimeout: TIMEOUT_MS,
          socketTimeout: TIMEOUT_MS,
        }),
    },
    MailService,
  ],
  exports: [MailService],
})
export class MailModule {}
```

- [ ] **Step 2: 빌드 · 린트 · 전체 테스트**

Run: `pnpm build && pnpm lint && pnpm test`
Expected: build 성공, lint 오류 0, 전체 suite 의 failed 0 (mail 3개 spec 포함). `pnpm lint` 는 `--fix` 로 파일을 고치므로 끝난 뒤 `git status` 로 바뀐 파일을 확인한다.

- [ ] **Step 3: DI 해석 확인 (일회성, 커밋하지 않음)**

`AppModule` 은 건드리지 않고, 임시 스크립트로 모듈만 띄워 `MailService` 가 해석되는지 본다. `scripts/` 는 빌드에서 빠지므로 거기에 둔다.

`scripts/_mail-di-check.ts`:

```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { MailModule } from '../src/mail/mail.module';
import { MailService } from '../src/mail/mail.service';
import { PrismaModule } from '../src/prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env.local' }),
    PrismaModule,
    MailModule,
  ],
})
class CheckModule {}

void (async () => {
  const app = await NestFactory.createApplicationContext(CheckModule, {
    logger: false,
  });
  console.log(app.get(MailService) ? 'MailService resolved' : 'missing');
  await app.close();
})();
```

Run: `pnpm exec ts-node scripts/_mail-di-check.ts && rm scripts/_mail-di-check.ts`
Expected: `MailService resolved`. `createApplicationContext` 는 `init` 을 하므로 `.env.local` 의 DB 에 접속한다. 끝나면 `git status` 에 스크립트가 남지 않았는지 본다.

- [ ] **Step 4: okf 문서**

`okf/api/mail.md` — 프런트매터는 `okf/api/alimtalk.md` 형식을 따른다. `generated: { by: claude-code/opus-5.5, at: <UTC 지금> }`, `status: draft`, `sources` 에 `src/mail/mail.service.ts` · `render-template.ts` · `mail.config.ts` · `mail.module.ts` 와 각 `last_modified`. `verified` 는 넣지 않는다. 본문은 설정값을 옮겨 적지 말고 결과와 함정을 쓴다:

- 쓰는 법: `MailModule` import, `send({ templateCode, to, variables, maskedVariables?, adminAccountId?, sentBy? })` 예시
- 템플릿 본문은 완성된 HTML 이고 링크는 본문 안 `<a href="#{링크}">` — 공통 틀이 없다. `isButtonLink` 는 저장 검사용이고 발송 코드는 읽지 않는다
- **지금 시드 EMAIL 템플릿은 일반 텍스트이고 `#{링크}` 가 본문에 없다** — 그대로 보내면 줄바꿈이 사라지고 링크가 빠진다. HTML 로 바꾸기 전에는 실제 발송에 쓸 수 없다
- 이력: 시도마다 한 행, 가림은 호출부가 지정, 가림 이름 오타는 던진다
- 실패의 의미: 검증 실패는 기록 없음, SMTP 실패는 FAILED 후 재던짐, 타임아웃은 「안 갔다」가 아님, 이력 INSERT 실패는 삼킴(이유)
- 트랜잭션 밖(커밋 뒤)에서 부른다
- 직원 앱 계정 수신자는 `admin_account_id` NULL — 테이블에 자리가 없다
- `AppModule` 에 없다 — 첫 사용처가 import 한다

`okf/index.md` API 목록, alimtalk 줄 아래:

```
* [Mail (Gmail SMTP)](/api/mail.md) - Shared MailService: fills an EMAIL template's HTML, sends through Gmail, and logs every attempt to mail_send_logs with caller-chosen masking.
```

`okf/log.md` `## 2026-10-07` 바로 아래 첫 줄:

```
* **Creation**: [Mail (Gmail SMTP)](/api/mail.md) — `src/mail/` 메일 발송 공통 기능. 템플릿 HTML 을 채워 Gmail 로 보내고 시도마다 `mail_send_logs` 에 남긴다(가림은 호출부 지정). 시드 EMAIL 본문이 아직 텍스트라 실제 발송 전에 HTML 로 바꿔야 한다.
```

- [ ] **Step 5: 커밋**

```bash
git add src/mail/mail.module.ts okf/api/mail.md okf/index.md okf/log.md
git commit -m "feat: MailModule 과 메일 발송 okf 문서"
```

---

## Self-Review 결과

- Spec 대비: 인터페이스(Task 3), 검증 5종(Task 2·3), 렌더·이스케이프·가림(Task 2), 이력 컬럼·SUCCEEDED/FAILED·재던짐·INSERT 실패 삼킴(Task 3), 설정·타임아웃·AppModule 미연결(Task 1·4), okf·.env.example(Task 1·4), 범위 밖 항목의 문서화(Task 4) — 빠진 항목 없음.
- 타입 이름: `renderMail` · `MailTemplateSource` · `TemplateVariable` · `RenderedMail` · `MASK` · `MAIL_TRANSPORT` · `MAIL_CONFIG` · `SendMailInput` · `MailSendResult` 를 모든 Task 에서 같은 철자로 쓴다.
