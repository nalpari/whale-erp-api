---
type: API
title: Kakao Alimtalk (Bizppurio)
description: Shared entry point for sending Kakao Alimtalk through Bizppurio; where the wording lives, token caching, and what "sent" does and does not mean.
tags: [notification, alimtalk, bizppurio, kakao]
status: draft
generated: { by: claude-code/opus-5.5, at: 2026-10-07T01:55:49Z }
sources:
  - id: alimtalk-service
    resource: ../../src/alimtalk/alimtalk.service.ts
    title: AlimtalkService (render, validate, send, log)
    last_modified: 2026-10-06T08:51:47Z
  - id: alimtalk-templates
    resource: ../../src/alimtalk/alimtalk-templates.ts
    title: Template registry and variable typing
    last_modified: 2026-10-06T08:51:47Z
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
    last_modified: 2026-10-06T09:01:03Z
---

# Using it

A domain module imports `AlimtalkModule` and injects `AlimtalkService`. The
module lives in `src/alimtalk/`, not `src/notifications/`: the naming glossary
gives `notification` to 운영 알림, a domain resource that will want that folder.
Once a template is registered (the registry is empty today), a call looks like
this — the code and variable names here are illustrative:

```ts
await alimtalk.send('TEMPLATE_CODE', staffMember.phone, { storeName, joinUrl });
```

`send` resolves once Bizppurio has **accepted** the message (`code 1000`) and
returns `{ refKey, messageKey }`. It throws otherwise — a `BizppurioError`
carrying Bizppurio's `code` and the HTTP status, or a plain `Error` when the
input is wrong (unknown template, unfilled variable, not a mobile number).
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
lock), so it waits for the send-log table.

Today the only record of a send is one log line: `alimtalk ACCEPTED`
(template code, `refKey`, `messageKey`, masked phone `010****5678`) or
`alimtalk FAILED` (template code, `refKey`, Bizppurio code, HTTP status,
masked phone, error message). A call rejected by input validation throws
before that point and logs nothing — a caller that swallows the error leaves
no trace. The rendered body is never logged — it
carries names, invite codes, and, in the temp-password template, a usable
password.

# Initial wording is code; the live wording is `notification_templates`

**Decided 2026-10-07 (재영), not yet built.** Operating reference data is
inserted once by migration and changed afterwards by an operator on screen —
the rule 1팀 already follows for its seed data. For 알림톡 that splits the
template in two:

| | Owned by | Changed how |
|---|---|---|
| Body (the wording) | `notification_templates.body` | 플랫폼 운영자 edits it on screen after Kakao approves the new text |
| Bizppurio template code, variable list, required flags | code | deploy; the screen cannot change them |
| `ALIMTALK_TEMPLATES` body | code | only the value the migration inserts first |

So `ALIMTALK_TEMPLATES` stops being what is sent. A send reads the row's
`body` and fills it. The rule about Kakao is unchanged — the body must match
the approved text byte for byte, or Bizppurio rejects the send — but nothing
in the system enforces it any more: an operator who saves wording Kakao has
not approved finds out from the rejection in the delivery record. That is
accepted; there is no approval state to check against
([Team 3 physical schema](/domain/team3-physical-schema.md)).

Saving checks the variables, as for the other channels: a `#{name}` outside
the code's list for that template, or a required one missing, is a 400. That
check is what keeps the next point true.

**Compile-time variable checking has to move off the body.** Today the
variable names are pulled out of the body literal by the type system
(`#{storeName}` → `storeName`), so a caller that forgets one fails to compile.
Once the live body comes from the database, the literal only describes the
first version. Derive the type from the declared variable list instead: the
save check guarantees every stored body uses only listed names, so a caller
that passes the whole list still cannot miss one the body needs. Typed from
the body, the check would silently go stale the first time an operator edits
it. Until that change, the code below is how it works today.

## How the code works today

`AlimtalkService` still sends `ALIMTALK_TEMPLATES` text, keyed by Bizppurio
template code. The variable names are pulled out of the body and the title by
the type system, so a caller that forgets a variable fails to compile. That
only works while the body stays a string literal: the registry is declared
`as const satisfies …`, and `satisfies` alone widens `body` to `string`,
turning the variables type into `{}` — every call then compiles. Annotating the
object with a wider type erases the names the same way. At runtime a variable
whose value is not a string (missing, or `null` from a nullable column) is
still caught before sending; an empty string is treated as a value.

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
confirm, a send-log table, and 429/5xx retries. Template bodies are not yet
in the registry: they must be copied verbatim from the legacy
`message_templates` rows, and become the initial `notification_templates` rows.
Reading the body from `notification_templates` at send time (above) is also
not built.
