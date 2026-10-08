---
type: API
title: Kakao Alimtalk (Bizppurio)
description: Shared entry point for sending Kakao Alimtalk through Bizppurio; where the wording lives, token caching, and what "sent" does and does not mean.
tags: [notification, alimtalk, bizppurio, kakao]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-08T01:42:46Z }
sources:
  - id: alimtalk-service
    resource: ../../src/alimtalk/alimtalk.service.ts
    title: AlimtalkService (look up, render, send, log)
    last_modified: 2026-10-08T01:42:46Z
  - id: bizppurio-client
    resource: ../../src/alimtalk/bizppurio.client.ts
    title: Bizppurio REST client (token cache, 3002 retry)
    last_modified: 2026-10-06T08:51:47Z
  - id: bizppurio-config
    resource: ../../src/alimtalk/bizppurio.config.ts
    title: BIZPPURIO_* env validation at startup
    last_modified: 2026-10-06T08:51:47Z
  - id: alimtalk-module
    resource: ../../src/alimtalk/alimtalk.module.ts
    title: AlimtalkModule (not wired into AppModule)
    last_modified: 2026-10-08T00:35:47Z
  - id: notification-templates-render
    resource: ../../src/notification-templates/render-template.ts
    title: renderTemplate (shared by mail and alimtalk)
    last_modified: 2026-10-08T00:35:47Z
  - id: notification-templates-find
    resource: ../../src/notification-templates/find-template.ts
    title: findSendableTemplate (missing / off / wrong channel)
    last_modified: 2026-10-08T00:35:47Z
  - id: alimtalk-send-logs-migration
    resource: ../../prisma/migrations/20261008000100_team3_alimtalk_send_logs/migration.sql
    title: alimtalk_send_logs (one row per Bizppurio attempt)
    last_modified: 2026-10-08T01:26:26Z
---

# Using it

A domain module imports `AlimtalkModule` and injects `AlimtalkService`. The
module lives in `src/alimtalk/`, not `src/notifications/`: the naming glossary
gives `notification` to 운영 알림, a domain resource that will want that folder.
A call names the `notification_templates` row by its template code:

```ts
await alimtalk.send({
  templateCode: 'TALK_STAFF_INVITATION',
  to: invitation.phone,
  variables: { 근무지: store.name, 링크: joinUrl },
  maskedVariables: ['링크'],
  related: { type: 'INVITATION', id: invitation.invitationId }, // 선택
  sentBy: adminAccountId, // 선택 — 관리자가 대신 보냈을 때
});
```

`maskedVariables` must name variables of the template; their values are
`********` in the send log. `related` takes type and id together, because the
table's CHECK refuses one without the other.

**That call does not deliver a working invitation yet.** `링크` is a button-link
variable (`isButtonLink: true`): the body has no `#{링크}`, so `send` requires
the value and then drops it, and the Bizppurio request carries no button. See
Not built.

`send` resolves once Bizppurio has **accepted** the message (`code 1000`) and
returns `{ referenceKey, messageKey }`. It throws otherwise — a `BizppurioError`
carrying Bizppurio's `code` and the HTTP status, or a plain `Error` when the
input is wrong (template missing, switched off or not ALIMTALK — each with
its own message — unfilled or unknown variable, a `#{…}` the template does not
declare, not a mobile number).
Inputs are checked before anything leaves the process.

# Accepted is not delivered

Bizppurio reports the real delivery outcome later, through its result-polling
API, and this module does not poll yet. A resolved `send` means "handed to
Bizppurio", nothing more.

The reverse does not hold either. A `BizppurioError` with no `code` (network
error, timeout, or a body cut off after the headers arrived on `/v3/message`)
means no readable answer came back, not that nothing was accepted — Bizppurio may already have taken the message. Retrying it
automatically can deliver the same message twice, a temp password included.

Polling needs a place to record results and a
multi-instance guard ([Employment Contract Batch](/api/employment-contract-batch.md)'s
lock); the send log below keeps `reference_key`, which is what a result report is
matched on.

# Every attempt leaves one row in alimtalk_send_logs

Each call that reaches Bizppurio writes one row: `SUCCEEDED` with
`message_key` when accepted, `FAILED` with `code=… http=…: message` when not —
the full message in the row, cut to 1000 characters in the log line. A thrown
value that is not an `Error` is recorded as its string and rethrown unchanged. The row
holds the digits-only number, both template codes (ours and the Kakao one, as
they were at send time), the masked body, `reference_key`, and `related` / `sent_by`
when given.

A call rejected by input validation throws before Bizppurio and leaves no row —
nothing was sent. If the INSERT itself fails, `send` does not throw: the message
is already out, and a throw would invite a resend. It logs
`alimtalk_send_logs INSERT FAILED` with the error name and code, `related` and
`sentBy`, never the error message — Prisma's message prints the whole `data`,
number and body included. An unknown `sentBy` is the usual cause (P2003).

The app log still has one line per attempt: `alimtalk ACCEPTED` or
`alimtalk FAILED`, with the masked phone `010****5678`. The rendered body is
never logged — it carries names and invite links; in the table it is masked
only where the caller said so.

# Templates live in `notification_templates`; code only seeds them

Decided 2026-10-07 (재영), built 2026-10-07. Operating reference data is
inserted once by migration and changed afterwards by an operator on screen —
the rule 1팀 already follows for its seed data. Templates go further: 플랫폼
운영자 also **registers** new ones, and every field of every template is
editable — wording, variable list, template name and code, channel,
and the Bizppurio template code.

A send names the template by its `template_code`, reads the row, and fills `#{…}` from `variables`. The rule about Kakao is
unchanged — an 알림톡 body must match the approved text byte for byte, or
Bizppurio rejects the send — but nothing in the system enforces it: wording
Kakao has not approved shows up as a rejection in the delivery record. There
is no approval state to check against
([Team 3 physical schema](/domain/team3-physical-schema.md)).

Saving checks the variables: a `#{name}` in the body or title that is not in the
template's variable list, or a required variable the body does not use, is a 400.

**Compile-time checking of variables is gone, and nothing replaces it at
compile time.** With the variable list in the database, the caller's code and
the template can disagree after any save. The check moves to the send (재영,
2026-10-07): a missing required value, a template switched off
(`is_active = false`), or an unknown `template_code` means the message is not
sent and `send` throws an `Error` naming the reason; the service itself logs
nothing for these — the caller or the exception filter does. Callers for whom a lost
notification is acceptable catch it; the others — a temp password, say — let
it fail the request. An optional variable without a value renders as empty.

Two of those failures come from operators, not developers, and surface only at
the send: switching a template off, and renaming its code, which breaks every
caller still using the old one. All template codes stay editable, the 37
defaults included; the screen warns before a rename, and a send stopped by a
confirmed rename is the operator's responsibility (운영 정책 NTF-24).

There is no `notify(type)` that fans out to every channel of a type. The same
type reaches different people per channel — 운영 알림 to 관리자, 앱 푸시 to 직원
— so callers call `send(templateCode)` once per channel.

## How the code works today

`send` reads the row with `findSendableTemplate` and fills it with
`renderTemplate`, both in `src/notification-templates/` and shared with
[Mail (Gmail SMTP)](/api/mail.md). The body goes out unescaped — 알림톡 is
text, so `<` and `&` are sent as typed. Bizppurio's `templatecode` is the
row's `kakao_template_code`, not our `template_code`; the CHECK
`notification_templates_alimtalk_fields` guarantees an ALIMTALK row has one.

The code registry (`ALIMTALK_TEMPLATES`), the compile-time variable types and
the title (강조 표기형) are gone — CHECK `notification_templates_title_by_channel`
keeps an ALIMTALK row's `title` NULL. A missing row, a switched-off one and one
on another channel throw different messages, because an operator's switch and
a typo in code need different fixes.

When a body embeds the protocol (`https://#{joinUrl}`), pass the URL without
it.

# Call it after the transaction commits

Sending is an external side effect; a rollback cannot recall it. Call `send`
after `prisma.$transaction(...)` has resolved, not inside the callback. Where
a failed notification must not fail the request (best-effort), catch at the
call site — the service deliberately does not swallow errors, because some
callers need to know.

# Configuration

Four keys, all required as soon as anything imports `AlimtalkModule`;
a blank one, or a base URL that is not `https`, stops the server at boot
rather than at the first send:
`BIZPPURIO_BASE_URL` (`https://dev-api.bizppurio.com` for review,
`https://api.bizppurio.com` for production), `BIZPPURIO_ACCOUNT`,
`BIZPPURIO_PASSWORD`, `BIZPPURIO_SENDER_KEY`. That is also why the module is
not in `AppModule` while nothing uses it — wiring it in would make every
environment need the keys.

The token's expiry is read from the issue response (24 hours today). From 10
minutes before it, the next send fetches a new one — there is no background
refresh. Concurrent sends share an issuance already in flight. A `3002` (token
invalid) response drops the cached token and retries once. Every HTTP request
has a 30-second timeout, because `fetch` (undici) otherwise waits up to five
minutes each for headers and body. It is per request, not per `send`: token issue, send, reissue,
and resend can each take it, so one `send` can wait up to about two minutes.

# Not built

SMS fallback (the legacy system has it, but switched off), result polling and
confirm, and 429/5xx retries.

Button links are not sent. Nothing reads `isButtonLink`, and the request has no
`at.button`, so a template whose link lives in a button — `TALK_STAFF_INVITATION`
today — goes out without it, or is rejected if Kakao registered the template
with a button. Sending buttons (Bizppurio `at.button`, type WL) has to come
before the first caller of that template.
