# 첨부파일 저장소 공통 기능 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 업무 모듈이 `StorageService` 하나로 파일을 S3 에 올리고(`put`), 짧은 내려받기 주소를 만들고(`downloadUrl`), 지운다(`delete`). 올린 파일의 종류는 파일 내용으로 판정한다(`detectFileType`).

**Architecture:** `src/storage/` 모듈 하나. 설정 읽기(`storage.config.ts`), 파일 내용 판정(`file-signature.ts`, 순수 함수), S3 호출을 감싼 `StorageService`, 설정이 없으면 `null` 을 주는 `StorageModule`. 업로드 API 와 공통 파일 테이블은 만들지 않는다 — 스키마가 도메인마다 첨부 테이블(`storage_key` 칼럼)을 두므로, multipart 를 받는 쪽은 각 업무 API 다.

**Tech Stack:** NestJS 11, `@aws-sdk/client-s3` · `@aws-sdk/s3-request-presigner` (v3, 새로 설치), Jest + ts-jest.

**Spec:** 별도 설계 문서 없음. 근거는 운영 정책 CNT-18(v118), Plane WHALEERP-587, 2026-10-14 재영 결정(아래 Global Constraints).

## Global Constraints

- 버킷: 1차 버킷 `whale-erp-files` 를 같이 쓴다. 접두(`v2/`)는 두지 않는다.
- 키 규칙: `{도메인}/{ID}/{UUID}.{확장자}`. 맨 앞 폴더는 1차가 쓰던 `images` · `attachments` 와 겹치면 안 된다 — `images/` 에는 공개 버킷 정책이 걸려 있다.
- 환경변수: `AWS_S3_BUCKET`, `AWS_S3_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`. `.env.example` 에는 이미 키만 들어가 있다(이 브랜치의 첫 커밋으로 넣는다).
- 키 두 개는 코드에서 읽지 않는다 — AWS SDK 기본 자격 증명 체인이 같은 이름을 읽는다. 배포 서버에 IAM 역할을 붙이면 비워 둔다.
- 값이 없을 때: `AWS_S3_BUCKET` · `AWS_S3_REGION` 이 둘 다 비면 서버는 뜨고 첨부 기능만 503. 하나만 넣었으면 기동 단계에서 던진다(메일의 `readOptionalMailConfig` 와 같은 규칙).
- 업로드는 서버 경유. 내려받기는 presigned GET, 유효 300초. 공개 URL 은 만들지 않는다.
- 파일 종류는 확장자·Content-Type 이 아니라 앞 바이트로 판정한다: JPG · PNG · PDF.
- 업로드 검사 위반(종류 · 크기 · 개수)은 모두 400 이다. Multer 크기 초과의 413 도 400 으로 바꾼다 (2026-10-14 재영).
- 허용 종류는 그 첨부 테이블 `file_type` 칼럼의 Prisma enum 값을 쓴다 — 예) `assertUpload(file, Object.values(AttachmentFileType))`, 점포 이미지는 `Object.values(StoreImageFileType)`. 업무 코드에 목록을 따로 적지 않는다. front 는 같은 값을 `GET /enums/{이름}` 으로 받아 `<input accept>` 와 안내 문구를 그린다. 관리자가 화면에서 바꾸는 설정은 두지 않는다 (2026-10-14 재영).
- S3 오류는 Nest HTTP 예외가 아닌 `Error` 그대로 올린다 — 메일·알림톡과 같이 호출부가 처리한다. 설정이 없을 때만 `ServiceUnavailableException`.
- 테스트는 실제 S3 에 붙지 않는다. `send` 를 가짜로 바꾼 객체, 또는 가짜 자격 증명을 넣은 실제 `S3Client`(서명만 하고 네트워크는 쓰지 않음)로 본다.
- 테스트 실행: `corepack pnpm test <파일 이름 일부>` (`--` 쓰지 않는다). 성공 여부는 exit code 가 아니라 passed/failed 개수로 본다.
- 커밋 메시지: 영어 type 접두 + 한글 subject. 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. 버킷·리전 중 하나만 넣으면 기동이 멈춘다 — Task 1 테스트.
2. 앞 바이트가 짧거나(3바이트 미만) 비어 있어도 던지지 않고 `null` — Task 2 테스트.
3. `images` · `attachments` 와 대문자·`/`·`..` 가 든 도메인 이름은 키를 만들지 않는다 — Task 3 테스트.
4. 한글과 `'` `(` `)` `*` 가 든 파일 이름이 `filename*=UTF-8''…` 로 끝까지 인코딩된다 — Task 3 테스트. `encodeURIComponent` 는 이 넷을 그대로 두므로 따로 바꿔야 한다.
5. 내려받기 주소의 유효 시간이 300초다(`X-Amz-Expires=300`) — Task 3 테스트.

---

## File Structure

| 파일 | 책임 |
|---|---|
| `src/storage/storage.config.ts` | `AWS_S3_*` 읽기·검증 |
| `src/storage/file-signature.ts` | 앞 바이트로 JPG · PNG · PDF 판정 (순수) |
| `src/storage/upload-check.ts` | `assertUpload`(종류 · 크기 → 400), `AttachmentsInterceptor`(Multer 한도, 413 → 400) |
| `src/storage/storage.service.ts` | 키 만들기, `put` · `downloadUrl` · `delete`, Content-Disposition |
| `src/storage/storage.module.ts` | `STORAGE` 토큰(없으면 `null`), `requireStorage` |
| `okf/api/storage.md` | 개념 문서 |
| `okf/index.md` | 링크 한 줄 |

---

### Task 0: 브랜치 준비

작업 트리 `~/.whale-erp-worktrees/whale-erp-api/santorini`, 브랜치 `pikachu`(`origin/main` 에서 `--no-track`)는 이미 만들었다. `.env.local` · `.env.dev` 를 복사했고 `pnpm install` 했다. 모든 명령은 이 작업 트리에서 실행한다. `.env.example` 수정(S3 키 네 개)이 커밋되지 않은 채 들어와 있다.

- [ ] **Step 1: `.env.example` 만 먼저 커밋**

```bash
git add .env.example
git commit -m "chore(env): 첨부파일 저장소 S3 환경변수 키 추가

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 2: 이 계획 문서 커밋**

```bash
git add docs/plans/2026-10-14-attachment-storage.md
git commit -m "docs(plans): 첨부파일 저장소 공통 기능 계획

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1: 저장소 설정 읽기 + AWS SDK 의존성

**Files:**
- Create: `src/storage/storage.config.ts`
- Test: `src/storage/storage.config.spec.ts`
- Modify: `package.json`, `pnpm-lock.yaml`

**Interfaces:**
- Produces: `type StorageConfig = { bucket: string; region: string }`, `readOptionalStorageConfig(get: (key: string) => string | undefined): StorageConfig | null`

- [ ] **Step 1: 의존성 설치**

```bash
corepack pnpm add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

두 패키지가 `dependencies` 에 들어갔는지, 두 버전이 같은지 `package.json` 에서 본다.

- [ ] **Step 2: 실패하는 테스트 작성**

```ts
// src/storage/storage.config.spec.ts
import { readOptionalStorageConfig } from './storage.config';

const config = (values: Record<string, string>) => (key: string) =>
  values[key];

describe('readOptionalStorageConfig', () => {
  it('둘 다 비면 null — 서버는 뜨고 첨부만 503 이다', () => {
    expect(readOptionalStorageConfig(config({}))).toBeNull();
    expect(
      readOptionalStorageConfig(
        config({ AWS_S3_BUCKET: ' ', AWS_S3_REGION: '' }),
      ),
    ).toBeNull();
  });

  it('둘 다 있으면 앞뒤 공백을 떼어 돌려준다', () => {
    expect(
      readOptionalStorageConfig(
        config({
          AWS_S3_BUCKET: ' whale-erp-files ',
          AWS_S3_REGION: 'ap-northeast-2',
        }),
      ),
    ).toEqual({ bucket: 'whale-erp-files', region: 'ap-northeast-2' });
  });

  it.each([
    [{ AWS_S3_BUCKET: 'whale-erp-files' }, 'AWS_S3_REGION'],
    [{ AWS_S3_REGION: 'ap-northeast-2' }, 'AWS_S3_BUCKET'],
  ])('하나만 넣으면 빈 키 이름으로 던진다 — 반쯤 넣은 설정은 실수다', (values, key) => {
    expect(() => readOptionalStorageConfig(config(values))).toThrow(key);
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `corepack pnpm test storage.config`
Expected: FAIL — `Cannot find module './storage.config'`

- [ ] **Step 4: 구현**

```ts
// src/storage/storage.config.ts
export type StorageConfig = {
  /** 1차와 같이 쓰는 버킷. 예) whale-erp-files */
  bucket: string;
  /** 예) ap-northeast-2 */
  region: string;
};

const KEYS = {
  bucket: 'AWS_S3_BUCKET',
  region: 'AWS_S3_REGION',
} as const;

/**
 * 저장소 설정을 읽는다. 둘 다 비면 null — 서버는 뜨고 첨부 기능만 503 이다. 하나만 있으면 던진다: 반쯤 넣은
 * 설정은 실수다. 액세스 키는 읽지 않는다 — AWS SDK 가 AWS_ACCESS_KEY_ID · AWS_SECRET_ACCESS_KEY 를 직접 읽고,
 * IAM 역할을 붙인 서버에서는 비어 있다.
 */
export function readOptionalStorageConfig(
  get: (key: string) => string | undefined,
): StorageConfig | null {
  const bucket = get(KEYS.bucket)?.trim();
  const region = get(KEYS.region)?.trim();
  if (!bucket && !region) return null;
  if (!bucket || !region) {
    const empty = bucket ? KEYS.region : KEYS.bucket;
    throw new Error(`${empty} 가 비어 있습니다. .env.<APP_ENV> 를 확인하세요.`);
  }
  return { bucket, region };
}
```

- [ ] **Step 5: 통과 확인**

Run: `corepack pnpm test storage.config`
Expected: 4 passed

- [ ] **Step 6: 커밋**

```bash
git add package.json pnpm-lock.yaml src/storage/storage.config.ts src/storage/storage.config.spec.ts
git commit -m "feat(storage): S3 저장소 설정 읽기와 AWS SDK 의존성

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 파일 종류 판정과 업로드 검사 (400 으로 통일)

**Files:**
- Create: `src/storage/file-signature.ts`, `src/storage/upload-check.ts`
- Test: `src/storage/file-signature.spec.ts`, `src/storage/upload-check.spec.ts`

**Interfaces:**
- Produces: `type FileKind = 'JPG' | 'PNG' | 'PDF'`, `detectFileType(head: Uint8Array): FileKind | null`
- Produces: `MAX_UPLOAD_BYTES = 10 * 1024 * 1024`, `assertUpload(file: { buffer: Buffer; size: number }, allowed: readonly FileKind[], maxBytes?: number): FileKind`
- Produces: `AttachmentsInterceptor(field: string, maxCount: number, maxBytes?: number): Type<NestInterceptor>`

값이 Prisma enum `AttachmentFileType`(JPG·PNG·PDF) · `StoreImageFileType`(JPG·PNG) 의 값과 같은 문자열이라, 호출부는 허용 목록과 비교만 하면 된다.

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// src/storage/file-signature.spec.ts
import { detectFileType } from './file-signature';

const bytes = (...values: number[]) => Uint8Array.from(values);

describe('detectFileType', () => {
  it.each([
    ['PNG', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00)],
    ['JPG', bytes(0xff, 0xd8, 0xff, 0xe0, 0x00)],
    ['PDF', Buffer.from('%PDF-1.7\n')],
  ])('%s 를 앞 바이트로 알아본다', (kind, head) => {
    expect(detectFileType(head)).toBe(kind);
  });

  it('확장자만 바꾼 글 파일은 알아보지 않는다', () => {
    expect(detectFileType(Buffer.from('hello.pdf'))).toBeNull();
  });

  it('비었거나 서명보다 짧으면 던지지 않고 null', () => {
    expect(detectFileType(bytes())).toBeNull();
    expect(detectFileType(bytes(0xff, 0xd8))).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `corepack pnpm test file-signature`
Expected: FAIL — `Cannot find module './file-signature'`

- [ ] **Step 3: 구현**

```ts
// src/storage/file-signature.ts
export type FileKind = 'JPG' | 'PNG' | 'PDF';

// 확장자와 Content-Type 은 보내는 쪽이 정하므로 믿지 않는다.
const SIGNATURES: [FileKind, number[]][] = [
  ['PNG', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ['JPG', [0xff, 0xd8, 0xff]],
  ['PDF', [0x25, 0x50, 0x44, 0x46, 0x2d]], // %PDF-
];

/** 파일 앞 바이트로 종류를 판정한다. 모르는 종류면 null. */
export function detectFileType(head: Uint8Array): FileKind | null {
  const match = SIGNATURES.find(([, signature]) =>
    signature.every((byte, i) => head[i] === byte),
  );
  return match?.[0] ?? null;
}
```

- [ ] **Step 4: 통과 확인**

Run: `corepack pnpm test file-signature`
Expected: 5 passed

- [ ] **Step 5: 업로드 검사 — 실패하는 테스트 작성**

업무 API 는 `@UseInterceptors(AttachmentsInterceptor('files', 5))` 로 받고, 파일마다 `assertUpload(file, ['JPG', 'PNG', 'PDF'])` 를 부른다. 종류 · 크기 · 개수 위반은 모두 400 이다(2026-10-14 재영). Nest 의 `FilesInterceptor` 는 Multer 크기 한도를 413 으로 바꾸므로 `AttachmentsInterceptor` 가 400 으로 다시 바꾼다. 개수 초과 같은 나머지 Multer 오류는 Nest 가 이미 400 으로 낸다.

```ts
// src/storage/upload-check.spec.ts
import { BadRequestException, Controller, Post, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { assertUpload, AttachmentsInterceptor } from './upload-check';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const file = (buffer: Buffer) => ({ buffer, size: buffer.length });

describe('assertUpload', () => {
  it('허용 목록에 있으면 판정한 종류를 돌려준다', () => {
    expect(assertUpload(file(PNG), ['JPG', 'PNG'])).toBe('PNG');
  });

  it('내용이 허용 목록에 없으면 400 — 확장자를 바꿔 올려도 막힌다', () => {
    expect(() => assertUpload(file(Buffer.from('%PDF-1.7')), ['JPG', 'PNG'])).toThrow(
      new BadRequestException('JPG · PNG 파일만 올릴 수 있습니다.'),
    );
    expect(() => assertUpload(file(Buffer.from('hello')), ['PDF'])).toThrow(BadRequestException);
  });

  it('크기를 넘으면 400', () => {
    expect(() => assertUpload(file(PNG), ['PNG'], PNG.length - 1)).toThrow(
      new BadRequestException(`파일은 ${PNG.length - 1}바이트까지 올릴 수 있습니다.`),
    );
  });
});

@Controller('upload-check-test')
class TestController {
  @Post()
  @UseInterceptors(AttachmentsInterceptor('files', 2, 10))
  upload(@UploadedFiles() files: unknown[]) {
    return { count: files.length };
  }
}

describe('AttachmentsInterceptor', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [TestController] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(() => app.close());

  it('한도 안이면 받는다', async () => {
    await request(app.getHttpServer())
      .post('/upload-check-test')
      .attach('files', Buffer.alloc(10), 'a.png')
      .expect(201, { count: 1 });
  });

  it('크기를 넘으면 413 이 아니라 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/upload-check-test')
      .attach('files', Buffer.alloc(11), 'a.png');
    expect(res.status).toBe(400);
  });

  it('개수를 넘어도 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/upload-check-test')
      .attach('files', Buffer.alloc(1), 'a.png')
      .attach('files', Buffer.alloc(1), 'b.png')
      .attach('files', Buffer.alloc(1), 'c.png');
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 6: 실패 확인**

Run: `corepack pnpm test upload-check`
Expected: FAIL — `Cannot find module './upload-check'`

- [ ] **Step 7: 구현**

```ts
// src/storage/upload-check.ts
import {
  BadRequestException,
  type CallHandler,
  type ExecutionContext,
  Injectable,
  mixin,
  type NestInterceptor,
  PayloadTooLargeException,
  type Type,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { detectFileType, type FileKind } from './file-signature';

/** 첨부파일 한 개의 기본 상한. 정책 표의 「10MB 이하」. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const tooLarge = (maxBytes: number) =>
  new BadRequestException(`파일은 ${maxBytes}바이트까지 올릴 수 있습니다.`);

/** 파일 하나를 검사한다. 종류는 내용으로 판정하고, 허용 목록에 없거나 크기를 넘으면 400. */
export function assertUpload(
  file: { buffer: Buffer; size: number },
  allowed: readonly FileKind[],
  maxBytes = MAX_UPLOAD_BYTES,
): FileKind {
  if (file.size > maxBytes) throw tooLarge(maxBytes);
  const kind = detectFileType(file.buffer);
  if (!kind || !allowed.includes(kind))
    throw new BadRequestException(`${allowed.join(' · ')} 파일만 올릴 수 있습니다.`);
  return kind;
}

/**
 * 메모리로 받는 FilesInterceptor 에 크기 한도를 건다. 한도가 없으면 큰 파일이 통째로 메모리에 올라온다.
 * Nest 는 크기 초과를 413 으로 내지만, 업로드 검사는 400 으로 통일한다(2026-10-14 재영).
 */
export function AttachmentsInterceptor(
  field: string,
  maxCount: number,
  maxBytes = MAX_UPLOAD_BYTES,
): Type<NestInterceptor> {
  const Base = FilesInterceptor(field, maxCount, { limits: { fileSize: maxBytes } });

  @Injectable()
  class Interceptor extends Base {
    async intercept(context: ExecutionContext, next: CallHandler) {
      try {
        return await super.intercept(context, next);
      } catch (error) {
        if (error instanceof PayloadTooLargeException) throw tooLarge(maxBytes);
        throw error;
      }
    }
  }
  return mixin(Interceptor);
}
```

- [ ] **Step 8: 통과 확인**

Run: `corepack pnpm test upload-check`
Expected: 6 passed

`크기를 넘으면 413 이 아니라 400` 이 413 으로 실패하면 `super.intercept` 가 오류를 Observable 로 돌려주는 것이다. 그때는 `catchError` 로 같은 변환을 한다.

- [ ] **Step 9: 커밋**

```bash
git add src/storage/file-signature.ts src/storage/file-signature.spec.ts src/storage/upload-check.ts src/storage/upload-check.spec.ts
git commit -m "feat(storage): 첨부파일 종류 판정과 업로드 검사(400 통일)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: StorageService — 키 · 올리기 · 내려받기 주소 · 지우기

**Files:**
- Create: `src/storage/storage.service.ts`
- Test: `src/storage/storage.service.spec.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `class StorageService { constructor(s3: S3Client, bucket: string) }`
  - `StorageService.newKey(domain: string, ownerId: number, extension: string): string` (static)
  - `put(key: string, body: Buffer, contentType: string): Promise<void>`
  - `downloadUrl(key: string, fileName: string): Promise<string>`
  - `delete(key: string): Promise<void>`
  - `contentDisposition(fileName: string): string`
  - `DOWNLOAD_URL_SECONDS = 300`

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// src/storage/storage.service.spec.ts
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { contentDisposition, StorageService } from './storage.service';

const BUCKET = 'whale-erp-files';

function fakeS3() {
  const send = jest.fn().mockResolvedValue({});
  return { s3: { send } as unknown as S3Client, send };
}

describe('StorageService.newKey', () => {
  it('{도메인}/{ID}/{UUID}.{확장자} 로 만든다', () => {
    expect(StorageService.newKey('inquiries', 12, 'pdf')).toMatch(
      /^inquiries\/12\/[0-9a-f-]{36}\.pdf$/,
    );
  });

  it.each(['images', 'attachments'])(
    '1차가 쓰던 맨 앞 폴더(%s)는 쓰지 않는다 — images/ 는 공개 정책이 걸려 있다',
    (domain) => {
      expect(() => StorageService.newKey(domain, 1, 'png')).toThrow(domain);
    },
  );

  it.each(['Inquiries', 'a/b', '..', '', 'store images'])(
    '소문자 · 숫자 · - 가 아닌 도메인 이름(%s)은 던진다',
    (domain) => {
      expect(() => StorageService.newKey(domain, 1, 'png')).toThrow();
    },
  );
});

describe('StorageService.put · delete', () => {
  it('put 은 버킷 · 키 · Content-Type 을 넣어 보낸다', async () => {
    const { s3, send } = fakeS3();
    const body = Buffer.from('%PDF-1.7');

    await new StorageService(s3, BUCKET).put('inquiries/1/a.pdf', body, 'application/pdf');

    const command = send.mock.calls[0][0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toEqual({
      Bucket: BUCKET,
      Key: 'inquiries/1/a.pdf',
      Body: body,
      ContentType: 'application/pdf',
    });
  });

  it('delete 는 그 키 하나만 지운다', async () => {
    const { s3, send } = fakeS3();

    await new StorageService(s3, BUCKET).delete('inquiries/1/a.pdf');

    const command = send.mock.calls[0][0] as DeleteObjectCommand;
    expect(command).toBeInstanceOf(DeleteObjectCommand);
    expect(command.input).toEqual({ Bucket: BUCKET, Key: 'inquiries/1/a.pdf' });
  });

  it('S3 오류는 그대로 올린다 — 호출부가 처리한다', async () => {
    const { s3, send } = fakeS3();
    send.mockRejectedValue(new Error('AccessDenied'));

    await expect(
      new StorageService(s3, BUCKET).put('inquiries/1/a.pdf', Buffer.alloc(1), 'application/pdf'),
    ).rejects.toThrow('AccessDenied');
  });
});

describe('StorageService.downloadUrl', () => {
  // 서명은 가짜 키로도 만들어진다. 네트워크는 쓰지 않는다.
  const s3 = new S3Client({
    region: 'ap-northeast-2',
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
  });

  it('300초짜리 presigned GET 이고 원래 파일 이름으로 내려받게 한다', async () => {
    const url = new URL(
      await new StorageService(s3, BUCKET).downloadUrl('inquiries/1/a.pdf', '계약서.pdf'),
    );

    expect(url.hostname).toBe(`${BUCKET}.s3.ap-northeast-2.amazonaws.com`);
    expect(url.pathname).toBe('/inquiries/1/a.pdf');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('response-content-disposition')).toBe(
      contentDisposition('계약서.pdf'),
    );
  });
});

describe('contentDisposition', () => {
  it('한글 이름을 RFC 5987 로 인코딩한다', () => {
    expect(contentDisposition('계약서.pdf')).toBe(
      "attachment; filename*=UTF-8''%EA%B3%84%EC%95%BD%EC%84%9C.pdf",
    );
  });

  it("encodeURIComponent 가 남기는 ' ( ) * 도 인코딩한다 — 헤더 값을 깨지 못하게", () => {
    expect(contentDisposition("a'b(1)*.pdf")).toBe(
      "attachment; filename*=UTF-8''a%27b%281%29%2A.pdf",
    );
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `corepack pnpm test storage.service`
Expected: FAIL — `Cannot find module './storage.service'`

- [ ] **Step 3: 구현**

```ts
// src/storage/storage.service.ts
import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** 내려받기 주소의 유효 시간. 권한을 확인한 뒤 주므로 짧게 둔다. */
export const DOWNLOAD_URL_SECONDS = 300;

// 1차 ERP 가 쓰던 맨 앞 폴더. 같은 버킷을 쓰므로 겹치지 않게 막는다 — images/ 는 공개 버킷 정책이 걸려 있다.
const FIRST_GEN_ROOTS = ['images', 'attachments'];
const DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** 원래 파일 이름으로 내려받게 하는 헤더 값. RFC 5987 — encodeURIComponent 가 남기는 ' ( ) * 까지 인코딩한다. */
export function contentDisposition(fileName: string): string {
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename*=UTF-8''${encoded}`;
}

/**
 * 첨부파일 저장소(S3). 업무 모듈이 multipart 를 받아 검사한 뒤 이 서비스로 올리고, DB 에는 키만 남긴다.
 * S3 오류는 Error 그대로 올린다 — 호출부가 처리한다.
 */
export class StorageService {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  /** `{도메인}/{ID}/{UUID}.{확장자}`. 도메인은 첨부가 붙는 업무 이름(예: inquiries)이다. */
  static newKey(domain: string, ownerId: number, extension: string): string {
    if (!DOMAIN_PATTERN.test(domain) || FIRST_GEN_ROOTS.includes(domain))
      throw new Error(`저장소 키에 쓸 수 없는 도메인 이름입니다: ${domain}`);
    return `${domain}/${ownerId}/${randomUUID()}.${extension}`;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /** 권한을 확인한 뒤 부른다. 주소를 가진 사람은 유효 시간 동안 누구나 받을 수 있다. */
  downloadUrl(key: string, fileName: string): Promise<string> {
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: contentDisposition(fileName),
      }),
      { expiresIn: DOWNLOAD_URL_SECONDS },
    );
  }

  async delete(key: string): Promise<void> {
    await this.s3.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `corepack pnpm test storage.service`
Expected: 14 passed

- [ ] **Step 5: 린트**

Run: `corepack pnpm lint`
Expected: 오류 0. Prettier 가 테스트의 긴 줄을 고치면 고친 대로 둔다.

- [ ] **Step 6: 커밋**

```bash
git add src/storage/storage.service.ts src/storage/storage.service.spec.ts
git commit -m "feat(storage): S3 올리기 · 내려받기 주소 · 지우기 서비스

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: StorageModule — 설정이 없으면 null, 쓰는 곳에서 503

**Files:**
- Create: `src/storage/storage.module.ts`
- Test: `src/storage/storage.module.spec.ts`

**Interfaces:**
- Consumes: `readOptionalStorageConfig` (Task 1), `StorageService` (Task 3)
- Produces: `STORAGE: symbol`, `type OptionalStorage = StorageService | null`, `StorageModule`, `requireStorage(storage: OptionalStorage): StorageService`

`AppModule` 에는 넣지 않는다. 첨부를 쓰는 업무 모듈이 `imports: [StorageModule]` 하고 `@Inject(STORAGE) storage: OptionalStorage` 로 받는다.

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// src/storage/storage.module.spec.ts
import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  requireStorage,
  STORAGE,
  StorageModule,
  type OptionalStorage,
} from './storage.module';
import { StorageService } from './storage.service';

async function resolve(env: Record<string, string>): Promise<OptionalStorage> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true, load: [() => env] }),
      StorageModule,
    ],
  }).compile();
  return moduleRef.get<OptionalStorage>(STORAGE);
}

describe('StorageModule', () => {
  it('설정이 없으면 null 로 뜬다', async () => {
    expect(await resolve({})).toBeNull();
  });

  it('설정이 있으면 StorageService 다', async () => {
    expect(
      await resolve({
        AWS_S3_BUCKET: 'whale-erp-files',
        AWS_S3_REGION: 'ap-northeast-2',
      }),
    ).toBeInstanceOf(StorageService);
  });

  it('하나만 있으면 기동 단계에서 던진다', async () => {
    await expect(resolve({ AWS_S3_BUCKET: 'whale-erp-files' })).rejects.toThrow(
      'AWS_S3_REGION',
    );
  });
});

describe('requireStorage', () => {
  it('null 이면 503', () => {
    expect(() => requireStorage(null)).toThrow(ServiceUnavailableException);
  });
});
```

`ConfigService.get` 은 `load` 값보다 `process.env` 를 먼저 본다. 이 테스트가 개발자 셸의 `AWS_S3_*` 를 집으면 첫 케이스가 깨지므로, 깨질 때는 `beforeEach` 에서 두 값을 지우고 `afterEach` 에서 되돌린다:

```ts
const saved = { ...process.env };
beforeEach(() => {
  delete process.env.AWS_S3_BUCKET;
  delete process.env.AWS_S3_REGION;
});
afterEach(() => {
  process.env = { ...saved };
});
```

- [ ] **Step 2: 실패 확인**

Run: `corepack pnpm test storage.module`
Expected: FAIL — `Cannot find module './storage.module'`

- [ ] **Step 3: 구현**

```ts
// src/storage/storage.module.ts
import { S3Client } from '@aws-sdk/client-s3';
import { Module, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readOptionalStorageConfig } from './storage.config';
import { StorageService } from './storage.service';

/** `AWS_S3_*` 가 없으면 null 인 StorageService. */
export const STORAGE = Symbol('STORAGE');

/** STORAGE 로 주입받는 값. null 이면 첨부 기능을 쓸 수 없다 — requireStorage 로 503 을 낸다. */
export type OptionalStorage = StorageService | null;

/** 첨부를 다루는 요청의 첫 줄에서 부른다. 저장소 설정이 없는 환경이면 503. */
export function requireStorage(storage: OptionalStorage): StorageService {
  if (!storage)
    throw new ServiceUnavailableException(
      '첨부파일 저장소가 설정되지 않았습니다.',
    );
  return storage;
}

// 첨부를 쓰는 업무 모듈이 import 한다. 설정이 없어도 기동은 하고 첨부만 503 이다 — 그래서 AppModule 에 넣지 않아도 된다.
@Module({
  providers: [
    {
      provide: STORAGE,
      inject: [ConfigService],
      useFactory: (config: ConfigService): OptionalStorage => {
        const storage = readOptionalStorageConfig((key) =>
          config.get<string>(key),
        );
        return (
          storage &&
          new StorageService(
            new S3Client({ region: storage.region }),
            storage.bucket,
          )
        );
      },
    },
  ],
  exports: [STORAGE],
})
export class StorageModule {}
```

- [ ] **Step 4: 통과 확인**

Run: `corepack pnpm test storage`
Expected: storage 폴더 테스트 5개 파일 모두 passed (4 + 5 + 6 + 14 + 4 = 33)

- [ ] **Step 5: 빌드 · 전체 단위 테스트**

Run: `corepack pnpm build && corepack pnpm test`
Expected: 빌드 성공, failed 0

- [ ] **Step 6: 커밋**

```bash
git add src/storage/storage.module.ts src/storage/storage.module.spec.ts
git commit -m "feat(storage): 설정이 없으면 첨부만 503 인 StorageModule

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 실제 버킷 확인 + 개념 문서

**Files:**
- Create: `okf/api/storage.md`
- Modify: `okf/index.md` (Service 목록에 한 줄)

- [ ] **Step 1: 실제 버킷에 한 번 올리고 받고 지우기 (커밋하지 않음)**

`.env.local` 의 값으로 `smoke/` 폴더에 올렸다가 지운다. 출력에 키 값이 나오지 않는다.

```bash
corepack pnpm exec dotenv -e .env.local -- node -e "
const { S3Client } = require('@aws-sdk/client-s3');
const { StorageService } = require('./dist/storage/storage.service');
(async () => {
  const s = new StorageService(new S3Client({ region: process.env.AWS_S3_REGION }), process.env.AWS_S3_BUCKET);
  const key = StorageService.newKey('smoke', 0, 'pdf');
  await s.put(key, Buffer.from('%PDF-1.7 smoke'), 'application/pdf');
  const res = await fetch(await s.downloadUrl(key, '확인.pdf'));
  console.log(res.status, res.headers.get('content-disposition'), await res.text());
  await s.delete(key);
  console.log('deleted', key);
})();
"
```

Expected: `200 attachment; filename*=UTF-8''%ED%99%95%EC%9D%B8.pdf %PDF-1.7 smoke` 그리고 `deleted smoke/0/…`. `aws s3 ls s3://whale-erp-files/smoke/` 가 비어 있는지 본다.

`dist/` 경로가 다르면 `ls dist` 로 확인해 고친다(`prisma.config.ts` 가 빠져 있으면 `dist/storage/…`).

- [ ] **Step 2: 개념 문서 작성**

`okf/api/storage.md`:

```markdown
---
type: API
title: Attachment storage (S3)
description: Shared StorageService for attachments — server-side upload after a content check, 5-minute presigned downloads, keys shaped {domain}/{id}/{uuid}.{ext} in the bucket shared with 1차 ERP; the server boots without S3 settings and only attachments return 503.
tags: [storage, s3, attachment]
status: draft
generated: { by: claude-code/opus-5.5, at: <커밋 시각 UTC> }
sources:
  - id: storage-service
    resource: ../../src/storage/storage.service.ts
    title: StorageService (key, put, downloadUrl, delete)
    last_modified: <커밋 시각 UTC>
  - id: storage-module
    resource: ../../src/storage/storage.module.ts
    title: STORAGE token and requireStorage
    last_modified: <커밋 시각 UTC>
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
- `allowed` is the Prisma enum of the table's `file_type` column
  (`Object.values(AttachmentFileType)`), never a list written in the business code. 관리자 웹
  and 직원 근무 앱 read the same values from `GET /enums/{name}` for `accept` and the hint text.
- Keys come from `StorageService.newKey(domain, ownerId, ext)`. `images` and `attachments`
  are refused: they are 1차's top folders, and `images/` is public by bucket policy.
- Downloads are `downloadUrl(key, fileName)` after the permission check — 300 seconds,
  saved under the original name. No public URLs.
- Inject `@Inject(STORAGE) storage: OptionalStorage` and call `requireStorage(storage)`
  first; without `AWS_S3_BUCKET`/`AWS_S3_REGION` it is null and the request gets 503.
- If the DB write fails after `put`, delete what was put. An object without a row is
  invisible garbage, not an error anyone will see.

# Configuration

`AWS_S3_BUCKET`, `AWS_S3_REGION` are read by `readOptionalStorageConfig`: both empty boots
without storage, one empty stops the boot. `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
are read by the AWS SDK itself and may be empty on a server with an IAM role.
```

`<커밋 시각 UTC>` 는 `date -u +%Y-%m-%dT%H:%M:%SZ` 값으로 바꾼다.

- [ ] **Step 3: 목록에 한 줄**

`okf/index.md` 의 `# Service` 목록, `Mail (Gmail SMTP)` 줄 바로 아래:

```markdown
* [Attachment storage (S3)](/api/storage.md) - Shared StorageService: content-checked server-side upload, 5-minute presigned downloads, `{domain}/{id}/{uuid}.{ext}` keys in the bucket shared with 1차; no S3 settings means attachments return 503.
```

- [ ] **Step 4: 변경 기록**

`okf/log.md` 맨 위 날짜 아래(오늘 날짜 제목이 없으면 `## 2026-10-14` 를 새로 만들어):

```markdown
- Added [Attachment storage (S3)](/api/storage.md): shared StorageService, keys in the bucket shared with 1차, 503 without settings.
```

- [ ] **Step 5: 커밋**

```bash
git add okf/api/storage.md okf/index.md okf/log.md
git commit -m "docs(okf): 첨부파일 저장소 개념 문서

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## 이 계획 밖 (첫 사용처가 정한다)

- **업무별 업로드 API**: 문의사항 등록, 공지사항 첨부, 종이 계약 등록, 점포 이미지. 각 업무 계획에서 `AttachmentsInterceptor` 의 개수 · 크기와 `assertUpload` 의 허용 목록을 정한다.
- **ID 를 아직 모를 때의 순서**: 키에 부모 ID 가 들어가므로 부모 행을 먼저 만들고 올린다. 트랜잭션 안에서 S3 를 부를지, 밖에서 부르고 실패하면 부모를 지울지는 첫 사용처(문의사항 등록)가 정한다.
- **결정 대기 (Plane WHALEERP-587)**: 환경별 버킷, 접속 권한 범위, 공개 파일, 애플리케이션 암호화, 소프트 삭제 뒤 객체 보관 기간. 정해지면 이 모듈을 고친다.
- **S3Client 종료 처리**: 1차는 종료 때 close 했다. v3 클라이언트는 keep-alive 소켓만 남기므로 넣지 않았다. 종료가 늦어지면 `onModuleDestroy` 에서 `destroy()` 를 부른다.
