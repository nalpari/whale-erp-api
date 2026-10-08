---
type: API
title: Mail (Gmail SMTP)
description: Shared MailService that fills an EMAIL template's HTML, sends it through Gmail, and records every attempt in mail_send_logs; what each failure means, and why the seed templates cannot be sent yet.
tags: [notification, mail, smtp, gmail]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-08T01:42:46Z }
sources:
  - id: mail-service
    resource: ../../src/mail/mail.service.ts
    title: MailService (validate, look up, render, send, record)
    last_modified: 2026-10-08T01:42:46Z
  - id: mail-render
    resource: ../../src/notification-templates/render-template.ts
    title: renderTemplate (shared with alimtalk; escapeBody for mail)
    last_modified: 2026-10-08T00:35:47Z
  - id: mail-config
    resource: ../../src/mail/mail.config.ts
    title: MAIL_* env validation at startup
    last_modified: 2026-10-07T07:22:45Z
  - id: mail-module
    resource: ../../src/mail/mail.module.ts
    title: MailModule (Gmail transport; not wired into AppModule)
    last_modified: 2026-10-07T07:49:58Z
  - id: mail-design
    resource: ../../docs/plans/2026-10-07-mail-sending-design.md
    title: Design decisions (2026-10-07)
    last_modified: 2026-10-07T07:08:09Z
---

# Using it

A domain module imports `MailModule` and injects `MailService`:

```ts
await mail.send({
  templateCode: 'EMAIL_TEMP_PASSWORD',
  to: account.email,
  variables: { 관리자이름: account.name, 임시비밀번호: password, 링크: loginUrl },
  maskedVariables: ['임시비밀번호'],
  adminAccountId: account.adminAccountId, // when the recipient is an 관리자 계정
  sentBy: operatorId,                     // when an 관리자 sent it on someone's behalf
});
```

The template is the `notification_templates` row with that `template_code`, and
it must be `channel = EMAIL` and `is_active`. Variable names are the row's
`variables[].name` exactly — the seed rows use Korean names. `mail_type_code` in
the log gets the template code, as the naming rules decided on 2026-10-07.

# The body is the whole HTML, and the seed rows are not HTML yet

A template's `body` is a complete HTML document, saved whole by the mail editor
that is still to come. There is no shared layout wrapped around it, and only an
HTML part is sent. Links are written into the body by the editor
(`<a href="#{링크}">`); the sending code never reads `isButtonLink`, which is
left with its other meaning — exempting a variable from the "required variables
must appear in the body" check when a template is saved.

**The EMAIL rows inserted by migration are still plain text, and none of them
has `#{링크}` in its body.** Sent as they are, line breaks collapse into one
paragraph and the link never appears — `EMAIL_STAFF_RESET_LINK` says 「아래 버튼을
눌러」 with no button under it. They cannot be used for a real send until their bodies are
replaced with HTML, by the editor or a new migration.

Values are HTML-escaped into the body — a name cannot become a tag, and a quote
in a URL cannot break out of `href`. The subject is a header, so values go in
as they are. Substitution is one pass: a value containing `#{…}` is not
substituted again.

The lookup and the rendering live in `src/notification-templates/`
(`findSendableTemplate`, `renderTemplate`) and are shared with
[Kakao Alimtalk (Bizppurio)](/api/alimtalk.md); mail calls the renderer with
`escapeBody: true`, 알림톡 without it.

# Every attempt leaves one row in mail_send_logs

| What happens | Row | `send` |
|---|---|---|
| Address is not exactly one mailbox or is longer than 254 characters, template missing / off / not EMAIL / no title, required variable missing, unknown variable name, a `#{…}` the template does not declare | none — nothing was sent | throws `Error` |
| Gmail accepts | `SUCCEEDED` | resolves `{ messageId }` |
| SMTP fails | `FAILED`, `failure_reason` = `code=… response=…: message` (a thrown non-`Error` is recorded as its string) | throws the original value unchanged |
| The log INSERT itself fails | none; `logger.error` with the error name, Prisma code and the two ids | as above — never throws for this |

The log INSERT failing is swallowed on purpose. The mail has already gone; if
`send` threw, the caller would see a failure and might issue and send a second
temporary password. A missing log row is the lesser harm. The error line leaves
out the error message, because a Prisma message prints the whole `data` — the
address and the body. A `P2003` there means a caller passed an `adminAccountId`
or `sentBy` that is not in `admin_accounts`, and every send from that call site
will lose its row the same way.

**Masking is the caller's choice.** `maskedVariables` names the values written
as `********` in the logged subject and body — temporary passwords, PINs. A
name that is not one of the template's variables throws instead of being
ignored: a typo there would otherwise store the password in clear text.

`to_email` is the address as sent. The table only has `admin_account_id`, so a
mail to a 직원 앱 계정 or a 도입문의 contact is logged with it NULL and is found by
address alone.

# A timeout is not "not sent"

Gmail may have accepted the message before the connection dropped, so nothing
retries. `ETIMEDOUT` is logged as `FAILED` with the code in `failure_reason`,
and whether to send again is the caller's decision. For the same reason, call
`send` after the transaction commits: a rollback cannot recall a mail.

The length check runs before the address pattern on purpose: the pattern
backtracks quadratically on many dots after `@` followed by a character that
cannot end an address (several seconds for 100,000 characters, with the event
loop blocked), so a caller that passes user input straight through cannot stall
the server.

Application logs carry the template code, `messageId` and a masked address
(`h***@example.com`) — never the body. SMTP error texts sometimes quote the
address (`550 … <HONG@example.com>`), possibly in another case, so every
address-shaped token in that text is masked before it is logged. The text is
cut to 1,000 characters first — the masking pattern is quadratic on a long
unbroken token — and a word split by the cut is replaced with `…`, since half an
address (`<hong.gil`) no longer looks like one and would slip through.
`failure_reason` keeps the text whole.

# Configuration

`MAIL_USERNAME` (the Gmail address, also the sender) and `MAIL_PASSWORD` (a
Google app password, not the account password). Both are required as soon as
anything imports `MailModule`; a blank one stops the server at boot. That is
why the module is not in `AppModule` while nothing sends mail — wiring it in
would make every environment need the keys. The first caller (1팀 임시 비밀번호
발급, 3팀 비밀번호 찾기) imports it.

Connection and socket timeouts are 30 seconds; nodemailer's defaults are two
and ten minutes. These bound each wait — connecting, and an idle socket — not the
send as a whole: DNS and the greeting have their own 30-second limits, and a
server that is slow but never silent can hold the caller longer.

# Not built

Bounce and delivery tracking, retries, a send queue, the mail editor and the
template management API, and HTML bodies for the seed templates.
