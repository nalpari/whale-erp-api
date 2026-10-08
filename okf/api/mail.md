---
type: API
title: Mail (Gmail SMTP)
description: Shared MailService that fills an EMAIL template's plain-text body, wraps it in the common mail layout with button links, sends it through Gmail, and records every attempt in mail_send_logs; what each failure means.
tags: [notification, mail, smtp, gmail]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-08T04:12:47Z }
sources:
  - id: mail-service
    resource: ../../src/mail/mail.service.ts
    title: MailService (validate, look up, render, layout, send, record)
    last_modified: 2026-10-08T04:12:47Z
  - id: mail-render
    resource: ../../src/notification-templates/render-template.ts
    title: renderTemplate (shared with alimtalk; masks button links)
    last_modified: 2026-10-08T04:12:47Z
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
    title: Design decisions (2026-10-07, revised 2026-10-08)
    last_modified: 2026-10-08T04:12:47Z
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

# The body is plain text; the layout and the button come from the code

운영 정책 NTF-22 (2026-10-07): a template's `body` is plain text, and the header,
footer and button are added by one shared mail layout. The seed rows follow it —
their bodies are plain text, and the link is a variable marked `isButtonLink: true`
with no `#{링크}` in the body. The code first assumed the opposite (the body as a
complete HTML document) and sent those rows without a link and with their line
breaks collapsed; that was corrected on 2026-10-08 after the team review of PR #6.

`send` fills the body as text, then HTML-escapes **all of it** — the template's
own words and the values — turns line breaks into `<br>`, and places it between
the header (`WHALE ERP`) and the footer. Each button-link value becomes a
「바로가기」 button. Escaping the whole body means an operator typing `<b>` in a
template shows `<b>`, not bold: the body is text by policy, so markup in it is
text too. A text part goes alongside — the body, then each link on its own
paragraph — for clients that do not render HTML.

**Button links must be `http://` or `https://`** (any case). Anything else —
`javascript:`, `data:`, a bare host, a protocol-relative `//…` — throws before
sending, so a value that came from user input cannot become a script link in an
`href`. Quotes in a link are escaped too. The error names the template, not the
value, since the link carries a token.

The subject is a header, so values go in as they are. Substitution is one pass:
a value containing `#{…}` is not substituted again.

The lookup and the rendering live in `src/notification-templates/`
(`findSendableTemplate`, `renderTemplate`) and are shared with
[Kakao Alimtalk (Bizppurio)](/api/alimtalk.md). The renderer does no escaping for
either channel and returns the button-link values as `links`; mail builds its
HTML from them, 알림톡 appends them to the SMS fallback.

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
will lose its row the same way. An id that could never be stored — not an integer in
`1..2147483647` — is caught before sending instead, so only a missing account
gets this far.

**Button links are always masked; the rest is the caller's choice.** A link
carries a token (reset, invitation), so a button-link variable is `********` in
the log even when the caller forgets it. `maskedVariables` adds to that — temporary
passwords, PINs. A name that is not one of the template's variables throws
instead of being ignored: a typo there would otherwise store the password in
clear text.

The logged `body` is the masked plain text, not the HTML that was sent: the
layout is the same for every mail, and a button link has no place in the body, so
the row shows what the template said.

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

Bounce and delivery tracking, retries, a send queue, and the template
management API. The button label is fixed (「바로가기」) — a template cannot name it.
