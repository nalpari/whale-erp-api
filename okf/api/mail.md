---
type: API
title: Mail (Gmail SMTP)
description: Shared entry point for sending plain-text mail through Gmail SMTP from notification_templates rows; what a failed template lookup does, and what Gmail does to the sender address.
tags: [notification, mail, smtp, gmail]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-07T05:03:45Z }
sources:
  - id: mail-service
    resource: ../../src/mail/mail.service.ts
    title: MailService (validate, render via templates, send, log)
    last_modified: 2026-10-07T05:03:45Z
  - id: mail-config
    resource: ../../src/mail/mail.config.ts
    title: MAIL_* env validation at startup
    last_modified: 2026-10-07T05:03:45Z
  - id: mail-module
    resource: ../../src/mail/mail.module.ts
    title: MailModule (Gmail transport; not wired into AppModule)
    last_modified: 2026-10-07T05:03:45Z
  - id: notification-templates-service
    resource: ../../src/notification-templates/notification-templates.service.ts
    title: NotificationTemplatesService (read row by template_code, check, fill)
    last_modified: 2026-10-07T05:03:45Z
  - id: render-template
    resource: ../../src/notification-templates/render-template.ts
    title: renderTemplate, shared with Alimtalk
    last_modified: 2026-10-07T04:54:46Z
---

# Using it

A domain module imports `MailModule` and injects `MailService`:

```ts
await mail.send('EMAIL_TEMP_PASSWORD', account.email, { memberName, password });
```

The wording is not in code. `send` reads the `notification_templates` row whose
`template_code` matches, requires `channel = EMAIL`, fills `#{…}` in `title`
(the subject) and `body`, and sends the body as **plain text** — no HTML, so
values need no escaping. Variable names are therefore not checked at compile
time; the check happens at the send, against the row's variable list.

`send` resolves once Gmail's SMTP server has accepted the message and returns its
`messageId`. A bounce after that is not seen. A timeout (`ETIMEDOUT`) does not
mean the mail was not sent — if the connection dropped after the body went out,
Gmail may already have it, so an automatic retry can deliver a temp password
twice. Call it after the transaction
commits, and catch at the call site where a lost mail is acceptable — the
service does not swallow errors.

# When the template does not fit the call

`NotificationTemplatesService.render` (shared with [Kakao Alimtalk](/api/alimtalk.md))
throws, after logging `template REJECTED template=… : <reason>`, when:

- no row has that `template_code` — including one an operator renamed;
- the row is another channel's (`send` on a `PUSH` template);
- the row is switched off (`is_active = false`);
- the title rule is broken — every channel but `ALIMTALK` needs a `title`, and
  an `ALIMTALK` row must not have one;
- an `ALIMTALK` row has no `kakao_template_code`;
- `variables` is not an array of `{name, isRequired}` — read loosely, a
  misspelled `isRequired` would turn a required password optional and send it
  blank;
- a variable marked `isRequired` has no string value (missing or `null`; an
  empty string counts as a value);
- the body or title has a `#{…}` the list does not name.

The table's CHECKs and the save API are meant to guarantee most of these, but
neither exists yet, and the default rows arrive by migration without passing a
save check — so the send checks again. A database error from the lookup itself
is thrown as is, without that log line.

An optional variable without a value becomes empty. A value the list does not
name is ignored. These are operator-caused failures that surface only at the
send — the template can change after the calling code was written (재영,
2026-10-07). Values are never logged.

`to` is validated first, before the database is read: it must be a single bare
address, because a comma or semicolon makes nodemailer read several recipients,
an angle bracket or quote turns the rest into a display name, and a colon, parenthesis or backslash is group or
comment syntax that makes the delivered address differ from the checked one.

# Not runnable against a database yet

`notification_templates` is one of 3팀's models with **no migration**
([Team 3 physical schema](/domain/team3-physical-schema.md)), so on a real
database the lookup fails with Prisma's `P2021` (table does not exist) until that migration — with its 37 default rows, 22
of them mail — is written and applied. The unit tests mock Prisma.

# Gmail specifics

- **The sender is the login account.** Gmail rewrites `From` to the authenticated
  address, so the service sends from `MAIL_USERNAME` with the display name
  `Whale ERP` instead of naming another address. The legacy default
  `noreply@whale-erp.com` is rewritten the same way unless it is registered as
  an alias of that Gmail account.
- **The password is an app password**, not the account password. Google shows it
  as four groups of four; whitespace is stripped when it is read.
- Port 465 (TLS from the first byte). Connection and socket-inactivity timeouts
  are 30 seconds, against nodemailer's defaults of 2 and 10 minutes; the
  greeting timeout is already 30 seconds by default and left alone.
- A wrong or revoked app password is not caught at boot — only blank values are.
  It first shows as `mail FAILED … code=EAUTH` on the first send.
- Gmail caps daily sends per account. A volume beyond a handful of transactional
  mails a day needs a different provider.

# Configuration

`MAIL_USERNAME` and `MAIL_PASSWORD`, both required as soon as anything imports
`MailModule`; a blank one stops the server at boot. The values come from the
legacy `whale-erp-api` `.env`. Like `AlimtalkModule`, the module is not in
`AppModule` while nothing uses it.

# Not built

The `notification_templates` migration and default rows, the send log (`mail_send_logs`), attachments (the legacy
payroll mails attached Excel files), and retries.
