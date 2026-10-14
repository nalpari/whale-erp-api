---
type: API
title: Attachment storage (S3)
description: Shared StorageService for attachments — server-side upload after a content check, optional JPEG thumbnail, 5-minute presigned downloads, keys shaped {domain}/{id}/{uuid}.{ext} in the bucket shared with 1차 ERP; the server boots without S3 settings and only attachments return 503.
tags: [storage, s3, attachment]
status: draft
generated: { by: claude-code/sonnet-5.5, at: 2026-10-14T07:52:58Z }
sources:
  - id: storage-service
    resource: ../../src/storage/storage.service.ts
    title: StorageService (key, put, downloadUrl, delete)
    last_modified: 2026-10-14T07:52:58Z
  - id: storage-module
    resource: ../../src/storage/storage.module.ts
    title: STORAGE token and requireStorage
    last_modified: 2026-10-14T07:52:58Z
  - id: storage-thumbnail
    resource: ../../src/storage/thumbnail.ts
    title: makeThumbnail (JPEG copy, EXIF stripped)
    last_modified: 2026-10-14T07:52:58Z
---

# What it is

`StorageService` puts, signs and deletes objects in the S3 bucket `whale-erp-files`, which
1차 ERP also used. There is no upload endpoint and no shared file table: each attachment
table (`inquiry_attachments`, `post_attachments`, `contract_documents`, `store_image_files`)
keeps only `storage_key`, and the business API that owns the table receives the multipart.

# Rules a caller must keep

- Receive with `AttachmentsInterceptor(field, maxCount)` and call
  `assertUpload(file, allowed)` on each file before `put`. Kind comes from the content, never
  the extension or `mimetype`; every violation is a 400, including Multer's size limit.
  The interceptor also caps multipart text fields at 50 per request and 100KB each (over the
  cap is a 400), so a request of many fields cannot fill memory.
- `put`, `downloadUrl` and `delete` refuse any key not shaped like `newKey`'s output
  (`{domain}/{id}/{uuid}.jpg|png|pdf`, domain not `images` or `attachments`) with a plain
  `Error`, before any S3 call — so first-generation files cannot be read, overwritten or deleted.
- `allowed` is the Prisma enum of the table's `file_type` column
  (`Object.values(AttachmentFileType)`), never a list written in the business code. 관리자 웹
  and 직원 근무 앱 read the same values from `GET /enums/{name}` for `accept` and the hint text.
- `assertUpload` returns the detected kind (typed as the narrower of `allowed`). Pass it on:
  keys come from `StorageService.newKey(domain, ownerId, kind)` and the upload is
  `put(key, buffer, kind)` — extension and Content-Type derive from `kind`, never from the
  client's file name or `mimetype`. `ownerId` must be a non-negative safe integer.
  `images` and `attachments` are refused: they are 1차's top folders, and `images/` is public
  by bucket policy.
- `AttachmentsInterceptor` decodes the client file name as UTF-8, so store
  `file.originalname` as the original name. Its violations are Korean 400s: kind
  (`JPG · PNG 파일만 …`), size in MB (`파일은 10MB까지 …`), count (`파일은 N개까지 …`),
  text fields (`텍스트 항목은 50개까지 …`, `텍스트 항목 하나는 100KB까지 …`).
- Downloads are `downloadUrl(key, fileName)` after the permission check — 300 seconds,
  saved under the original name. No public URLs.
- Thumbnails are opt-in per business: `put(key, buffer, kind, { thumbnail: { maxPx } })` makes a
  JPEG copy at `{domain}/{id}/{uuid}.thumb.jpg` for JPG and PNG only (PDF is skipped silently);
  `true` means 320, and `maxPx` must be an integer from 32 to 1024. Pick about twice the size
  shown on screen. The copy is resized to fit, never enlarged, rotated by EXIF and stripped of
  metadata. Lists use `thumbnailUrl(key)` (300 seconds, takes the original key), detail uses
  `downloadUrl`, and `delete(key)` removes both. Keep the choice constant per business and call
  `thumbnailUrl` only for images of a business that turned it on.
- Inject `@Inject(STORAGE) storage: OptionalStorage` and call `requireStorage(storage)`
  first; without `AWS_S3_BUCKET`/`AWS_S3_REGION` it is null and the request gets 503.
- If the DB write fails after `put`, delete what was put. An object without a row is
  invisible garbage, not an error anyone will see.

# Configuration

`AWS_S3_BUCKET`, `AWS_S3_REGION` are read by `readOptionalStorageConfig`: both empty boots
without storage, one empty stops the boot. `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
are read by the AWS SDK itself and may be empty on a server with an IAM role.
Thumbnails use `sharp`, which ships platform-specific binaries: run `pnpm install` inside the
deployment environment (the image build for Docker) and never copy `node_modules` from a Mac.
Locally, run `pnpm install` after pulling this change, or startup fails with
`Cannot find module 'sharp'`.
