---
type: API
title: Mail (Gmail SMTP)
description: Shared MailService that fills an EMAIL template's plain-text body, wraps it in the common mail layout with button links, sends it through Gmail, and records every attempt in mail_send_logs; what each failure means.
tags: [notification, mail, smtp, gmail]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-11-18T04:00:00Z }
sources:
  - id: mail-service
    resource: ../../src/mail/mail.service.ts
    title: MailService (validate, look up, render, layout, send, record)
    last_modified: 2026-11-18T04:00:00Z
  - id: mail-render
    resource: ../../src/notification-templates/render-template.ts
    title: renderTemplate (shared with alimtalk; masks button links)
    last_modified: 2026-10-08T04:12:47Z
  - id: mail-config
    resource: ../../src/mail/mail.config.ts
    title: MAIL_* env validation at startup
    last_modified: 2026-10-20T09:20:00Z
  - id: mail-logo
    resource: ../../src/mail/mail-logo.ts
    title: Whale logo PNG sent as an inline (cid) attachment
    last_modified: 2026-11-18T04:00:00Z
  - id: mail-module
    resource: ../../src/mail/mail.module.ts
    title: MailModule (Gmail transport; not wired into AppModule) · optionalMailServiceProvider
    last_modified: 2026-10-20T09:20:00Z
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
  accountId: account.adminAccountId,      // recipient's account id — an 관리자 계정 here (a 직원's accounts.account_id for the reset link)
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
own words and the values — and lays it out in the shared frame. Each button-link value becomes a
「바로가기」 button. Escaping the whole body means an operator typing `<b>` in a
template shows `<b>`, not bold: the body is text by policy, so markup in it is
text too. A text part goes alongside — the body, then each link on its own
paragraph — for clients that do not render HTML; only the HTML part gets the layout below.

**Layout ("C 커머스 안내형", 2026-11-18 user decision — shaped like Coupang · Kurly · SSG order notices so
the sender is obvious, a trust issue; a dark-band version was tried first and dropped).** One white sheet,
card pinned left: the whale logo and `WHALE ERP` · grey 「매장 통합관리 서비스」 at the top left (logo and text in
two table cells with `valign="middle"` so they line up in every client); a large bold heading — the mail
subject with its leading `[WHALE ERP]` removed (`mailHeading`), so no template needed a new field; the body
split by `bodyBlocks` — consecutive `- 항목: 값` lines (a space after the colon, label up to 30 chars, so
`- 10:00 …` and `- https://…` stay text) become rows in a grey rounded info box, `※` lines become small grey
text (an empty `※` line is dropped), everything else a 15px paragraph, and the template's own sentences each
get their own line (`sentences` — user request); full-width buttons in the admin web's hover look (white, 1px
slate `#6b7988` border, ink text, label centred); an 8px grey band; then the footer: 「본 메일은 발신전용으로
회신되지 않습니다.」, a blank line, (주)인터플러그 | 대표이사 이정선 | 사업자등록번호 …, address | phone (a small
light `|`, no `·` or `:`), and 「Copyrights© 2026 INTERPLUG. All Rights Reserved.」 (user-specified; values match
the guest-site footer). Background, box and button colours are also written as `bgcolor`.

**The block shape comes from the template, not the filled body.** `send` passes the unfilled
template body and `fillLine(values)`; `bodyBlocks` classifies each template line first, then fills
it. Classifying the filled body let a value with line breaks — a BP 상호명 typed on the public
signup form, an operator's free-text 답변 — fake an info row or an official-looking notice box in a
mail from WHALE ERP (PR #296 review). Now a value's line breaks stay inside its paragraph, become
spaces in a table cell, and sentence splitting never cuts a value (`1. …`, `Co. Ltd`).
Band, button and footer colours are also written as `bgcolor`, because some
dark-mode clients only invert `style` colours. The 29 seed EMAIL rows render sensibly without
edits — their key values (아이디, 임시 비밀번호, 근무지, 제목 …) are already `- 항목: 값` lines.

**The logo travels inside the mail.** Gmail and others do not show SVG or `data:` images, and the
admin web has no public production address yet, so `send` attaches the PNG in `mail-logo.ts` as an
inline attachment (`cid:whale-erp-logo`) and the band's `<img>` points at it — no hosting, no env
key. The PNG is a dark whale on its own white square, so a client that inverts the whole mail in dark mode
still shows it instead of a dark whale on a dark background.
A client that blocks images shows an empty spot; the wordmark is text and stays. To change the
logo, redraw front `public/guest/logo-whale.svg` + `logo-star.svg` in the same layout and
re-encode.

The frame is a table, not a `<div>`: an outer full-width table holds a 560px card
table at its **left** edge, and the outer cell, the MSO wrapper, the card cell and
every paragraph all carry `align="left"` / `text-align:left`; nothing in the frame
says `center`. The card cell repeats the font and colour because many clients drop `<body>` styles. Outlook desktop ignores `max-width`, so an MSO-only wrapper table (`<!--[if mso]>`) holds the 560px width there. Without an explicit alignment, clients that show a message
inside their own centred cell (Naver, Daum, Outlook) passed the centring on and
the body read centred (2026-11-13 user report). The card itself was still centred
after that fix, so the mail still looked centred; on 2026-11-18 the user asked for
the card to sit on the left too (통합테스트).

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
| Address is not exactly one mailbox or is longer than 254 characters (`isSendableEmail`, `src/mail/mail-address.ts` — the 직원 앱 e-mail change PIN DTO and 직원 앱 signup DTO check the same rule through `IsSendableEmail`, length first; the other DTOs that later mail the address they take — 관리자 회원가입, 플랫폼 관리자, 도입문의 — do not yet), template missing / off / not EMAIL / no title, required variable missing, unknown variable name, a `#{…}` the template does not declare | none — nothing was sent; `warn` `mail NOT SENT template=… to=<masked>: <reason>` | throws `Error` |
| Gmail accepts | `SUCCEEDED` | resolves `{ messageId }` |
| SMTP fails | `FAILED`, `failure_reason` = `code=… response=…: message` (a thrown non-`Error` is recorded as its string) | throws the original value unchanged |
| The log INSERT itself fails | none; `logger.error` with the error name, Prisma code and the ids (accountId · staffMemberId · sentBy) | as above — never throws for this |

`send` takes `accountId` (renamed from `adminAccountId`, 2026-11-13) and an optional `staffMemberId` beside `sentBy`, each validated as an id before sending. `mail_send_logs.account_id` is the 수신 계정: an `admin_accounts` id for mail to an 관리자, an `accounts.account_id` for mail to a 직원 (the reset link) — which one is told by `mail_type_code`, and the column has no foreign key. `staff_member_id` is the 수신 직원 (WHALEERP-676): the 관리자 초기화 reset link passes it so the mail appears in that 직원's 발송 이력 ([Staff members](/api/staff-members.md)); that column is `ON DELETE SET NULL`, so the log row survives a deleted 직원 record. If the INSERT hits a foreign-key violation (`P2003`) with a `staffMemberId` — the 직원 record was deleted in between — `record` inserts once more with `staff_member_id` NULL (the same state `SET NULL` would leave); if that fails too it logs as above.

**Callers can tell the two throwing rows apart** with `isMailTransportError(e)` (2026-10-20,
api #77): it is true only for what `send` rethrew from the SMTP step. The thrown value is not
wrapped — callers that already catch it see the same type — `send` only notes it in a
`WeakSet`, so a thrown non-object is never marked. Use it when the answer differs: an SMTP
failure may clear on a retry, a template switched off never will. 비밀번호 찾기, the
관리자 초기화 reset link and the 직원 앱 e-mail change PIN all answer the first with a 503
「잠시 후 다시」 and the second with a 500 — the reset link and the e-mail change PIN put a
「메일 설정 문제로 … 문의해 주세요.」 message on it and do not rethrow the original, whose
message can carry the address ([Authentication](/api/auth.md), [My profile](/api/my-profile.md)).

**A mail stopped before SMTP is logged by `send` itself** (2026-10-15, 도입문의 알림 · 메일 리뷰). It leaves no row, and
callers log only the error name and code because an SMTP message can carry the address — so without this
line a template switched off or a renamed variable showed up as `error=Error code=undefined` and nothing
else. The messages of that stage hold only the masked address, the template code and variable names.

The log INSERT failing is swallowed on purpose. The mail has already gone; if
`send` threw, the caller would see a failure and might issue and send a second
temporary password. A missing log row is the lesser harm. The error line leaves
out the error message, because a Prisma message prints the whole `data` — the
address and the body. A `P2003` there names the violated constraint (`meta.driverAdapterError.cause.constraint.index`): `mail_send_logs_sent_by_fkey` means a caller passed a `sentBy`
that is not in `admin_accounts` and is not retried; `mail_send_logs_staff_member_id_fkey` is retried once with the 직원 column NULL, and only a second failure reaches this line (if the constraint name cannot be read, the retry is attempted anyway), and every send from that call site
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

`to_email` is the address as sent. `account_id` is filled only by the callers that pass it (관리자 mail, and the 직원 reset link with the 직원's account id), so a
mail to another 직원 앱 계정 or a 도입문의 contact is logged with it NULL and is found by
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

The 관리자 초기화 reset link (WHALEERP-172) is the exception: it must not take
login down when `MAIL_*` is empty, so `AuthModule` does not import `MailModule`.
It reads the keys with `readOptionalMailConfig` (both empty → no mailer, one
empty → boot stops) and builds a `MailService` on the same `createMailTransport`
— see [Authentication](/api/auth.md). [Platform admins](/api/platform-admins.md)
does the same for its 초기 · 초기화 비밀번호 mails, adding `ADMIN_WEB_URL` for the
button: with either missing the api boots and those mails are simply not sent.
The 직원 앱 e-mail change PIN (WHALEERP-191) is built the same way by
`MyProfileModule` (`createEmailChangePinSender`): with `MAIL_*` empty every PIN
request is 503 and production logs an `error` at boot — [My profile](/api/my-profile.md).

문의 답변 메일(WHALEERP-274)과 도입문의 접수 확인 · 답변 메일(WHALEERP-296 · 588)도 같은 이유로 `MailModule` 을 import 하지 않고, 모듈 providers 에
`optionalMailServiceProvider` 를 넣어 `OPTIONAL_MAIL_SERVICE` 를 주입받는다 — 타입은 `OptionalMailService`
(`MailService | null`)로 받아 null 을 놓치지 않게 한다. 둘 다
비면 null 이라 그 메일만 건너뛰고, 하나만 있으면 기동이 멈춘다 — [Inquiry and lead handling](/api/inquiries.md).
BP 회원가입의 가입 완료 · 가입 알림 메일도 같은 방식이다 — [BP signup](/api/admin-signup.md).

Connection and socket timeouts are 30 seconds; nodemailer's defaults are two
and ten minutes. These bound each wait — connecting, and an idle socket — not the
send as a whole: DNS and the greeting have their own 30-second limits, and a
server that is slow but never silent can hold the caller longer.

# Not built

Bounce and delivery tracking, retries and a send queue. Template copy is
managed through [Notification templates](/api/notification-templates.md). The button label is fixed (「바로가기」) — a template cannot name it.
