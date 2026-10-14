# 첨부 이미지 썸네일 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `StorageService.put` 에 썸네일 옵션을 더해 JPG · PNG 원본과 함께 줄인 JPEG 사본을 저장하고(크기는 부르는 업무가 정함, 기본 320px), 썸네일 주소를 따로 주고, 지울 때 둘 다 지운다.

**Architecture:** 이미지 줄이기는 순수 함수 `makeThumbnail`(`src/storage/thumbnail.ts`, sharp)로 둔다. 썸네일 키는 원본 키에서 이끌어 낸다(`{도메인}/{ID}/{UUID}.thumb.jpg`) — DB 칸을 늘리지 않는다. `StorageService` 가 `put(…, { thumbnail })` · `thumbnailUrl` · `delete` 에서 이 키를 다룬다. 마이그레이션 없음.

**Tech Stack:** NestJS 11, `@aws-sdk/client-s3` 3.1150.0, `sharp` 0.35.5(새로 설치), Jest + ts-jest.

**Spec:** Plane WHALEERP-591 「[API] 첨부 이미지 썸네일」, 운영 정책 CNT-18 v124 (2026-10-14 재영). 앞선 계획: `docs/plans/2026-10-14-attachment-storage.md`.

## Global Constraints

- 썸네일은 `put(key, body, kind, { thumbnail: true })` 또는 `{ thumbnail: { maxPx } }` 일 때만, 그리고 `kind` 가 JPG · PNG 일 때만 만든다. PDF 는 옵션이 켜져 있어도 만들지 않는다(조용히 건너뜀 — 문의 첨부처럼 이미지 · PDF 가 섞여 들어오기 때문).
- 썸네일 크기는 부르는 업무가 정한다(2026-10-14 재영, A안): `{ thumbnail: { maxPx: 200 } }` 이면 긴 변 200px, `{ thumbnail: true }` 이면 기본 `THUMBNAIL_DEFAULT_PX`(320). `maxPx` 는 `THUMBNAIL_MIN_PX`(32) ~ `THUMBNAIL_LIMIT_PX`(1024) 정수만 받고 벗어나면 던진다. 크기를 나중에 바꾸면 그 뒤에 올린 파일부터 적용된다(이미 만든 사본은 다시 만들지 않는다). 파일 하나에 썸네일은 하나다.
- 썸네일은 JPEG, 긴 변이 정한 크기 안에 들어가게 비율을 지켜 줄인다. 원본이 더 작으면 키우지 않는다. EXIF 방향대로 돌리고, 메타데이터(EXIF · GPS)는 남기지 않는다. PNG 의 투명 영역은 흰 바탕으로 채운다.
- 썸네일 키는 원본 키에서 이끌어 낸다: `{도메인}/{ID}/{UUID}.{jpg|png}` → `{도메인}/{ID}/{UUID}.thumb.jpg`. `assertKey` 는 이 모양도 받고, 1차 폴더(`images` · `attachments`) 차단은 그대로다. `.thumb.png` · `.thumb.pdf` 같은 다른 모양은 받지 않는다.
- 내려받기: 원본은 `downloadUrl(key, fileName)` 그대로, 썸네일은 `thumbnailUrl(key)`(원본 키를 받는다). 둘 다 300초 presigned GET. inline 서명 · 만료 대응 · 확대 화면은 이번 범위가 아니다(재영 결정 대기).
- `delete(key)` 는 이미지면 썸네일을 먼저, 원본을 나중에 지운다 — 중간에 실패해도 사본만 남는 일이 없게(개인정보 파기). 썸네일이 없던 이미지도 그대로 부른다(S3 는 없는 키 삭제를 성공으로 본다).
- `put` 은 썸네일을 먼저 만들고(깨진 이미지면 아무것도 올리기 전에 던진다), 원본 → 썸네일 순으로 올린다. 썸네일 올리기가 실패하면 썸네일 → 원본 순으로 정리하고 실패하면 경고 로그를 남긴 뒤 원래 오류를 던진다.
- 깨진 이미지 · 픽셀 상한 초과는 한글 400(BadRequestException), maxPx 범위 오류는 Error (2026-10-14 재영).
- `thumbnailUrl` 은 PDF 면 null.
- 압축 폭탄 방지: 헤더(`metadata()`)를 먼저 읽어 형식별 픽셀 상한을 디코딩 전에 본다 — `THUMBNAIL_MAX_JPEG_PIXELS`(100_000_000, 줄여 읽기라 50MP 폰 사진 통과, 2026-10-14 재영) · `THUMBNAIL_MAX_PNG_PIXELS`(25_000_000, PNG 는 통째로 푼다). 넘으면 400 「이미지가 너무 큽니다.」. 파이프라인의 `limitInputPixels` 도 같은 값으로 한 번 더 둔다.
- 형식: JPEG · PNG 만 푼다. 그 밖(SVG · GIF · WebP · TIFF · HEIF 등)은 디코딩하지 않고 400 「이미지를 읽을 수 없습니다.」. 헤더 · 파이프라인 모두 `failOn: 'error'`(브라우저가 보여 주는 조금 깨진 JPEG 는 받고, 잘린 파일은 400).
- 시간: 한 장 `THUMBNAIL_TIMEOUT_SECONDS`(10초). 넘으면 400 이 아닌 일반 Error(500).
- 동시 처리: 프로세스 안에서 `THUMBNAIL_CONCURRENCY`(2)장까지, 나머지는 줄을 선다. `sharp.concurrency(1)` 로 한 장은 libvips 스레드 하나 — libuv 풀을 scrypt · dns 와 나눠 쓴다.
- `put` 은 키 확장자가 `kind.toLowerCase()` 와 다르면 S3 를 부르기 전에 Error 「키 확장자와 파일 종류가 다릅니다: {key} ({kind})」.
- 오류는 `Error` 그대로 올린다(기존 규칙). 테스트는 S3 에 붙지 않는다 — sharp 로 테스트 이미지를 만들어 쓴다.
- 테스트: `corepack pnpm test <패턴>` (`--` 쓰지 않음). `pnpm test` 는 타입을 검사하지 않으므로 마지막에 `corepack pnpm exec tsc --noEmit -p tsconfig.json` 도 돌린다.
- 커밋 메시지: 영어 type 접두 + 한글 subject, 끝에 `Co-Authored-By: <실제 모델> <noreply@anthropic.com>`. 푸시하지 않는다.

## Review Focus

1. 깨진 이미지(앞 바이트만 PNG)는 S3 를 한 번도 부르지 않고 던진다 — Task 2.
2. 썸네일 올리기가 실패하면 원본이 지워진다 — Task 2.
3. `delete` 가 썸네일을 원본보다 먼저 지운다 — Task 2.
4. `.thumb.png` · `.thumb.pdf` · `images/…/….thumb.jpg` 를 `assertKey` 가 막는다 — Task 2.
5. 썸네일에 EXIF 가 남지 않는다(사진의 GPS) — Task 1.
6. `maxPx` 가 범위 밖(31 · 1025 · 소수 · NaN)이면 S3 를 부르기 전에 던진다 — Task 1 · 2.

---

## File Structure

| 파일 | 책임 |
|---|---|
| `src/storage/thumbnail.ts` | `makeThumbnail(body, maxPx)` (sharp, 순수), 기본 크기 · 크기 범위 · 품질 · 입력 픽셀 상수 |
| `src/storage/storage.service.ts` | `thumbnailKey`, `assertKey` 확장, `put` 옵션, `thumbnailUrl`, `delete` 둘 다 |
| `okf/api/storage.md` · `okf/log.md` | 사용법 갱신 |

---

### Task 1: sharp 의존성 + makeThumbnail

**Files:**
- Create: `src/storage/thumbnail.ts`, `src/storage/thumbnail.spec.ts`
- Modify: `package.json`, `pnpm-lock.yaml`

**Interfaces:**
- Produces: `THUMBNAIL_DEFAULT_PX = 320`, `THUMBNAIL_MIN_PX = 32`, `THUMBNAIL_LIMIT_PX = 1024`, `THUMBNAIL_QUALITY = 80`, `THUMBNAIL_MAX_INPUT_PIXELS = 40_000_000`, `makeThumbnail(body: Buffer, maxPx?: number): Promise<Buffer>` (JPEG, maxPx 기본 THUMBNAIL_DEFAULT_PX)

- [ ] **Step 1: 설치**

```bash
corepack pnpm add sharp@0.35.5
```

sharp 0.33 부터는 설치 스크립트 없이 `@img/sharp-<플랫폼>` 미리 빌드된 패키지를 쓴다. 설치 중 「build scripts ignored」 경고가 sharp 에 대해 나오면 멈추고 보고한다(`pnpm-workspace.yaml` `allowBuilds` 에 더할지 판단해야 한다). `node -e "require('sharp')"` 가 오류 없이 끝나는지 본다.

- [ ] **Step 2: 실패하는 테스트**

```ts
// src/storage/thumbnail.spec.ts
import sharp from 'sharp';
import {
  makeThumbnail,
  THUMBNAIL_DEFAULT_PX,
  THUMBNAIL_MAX_INPUT_PIXELS,
} from './thumbnail';

const image = (width: number, height: number, format: 'png' | 'jpeg', alpha = false) =>
  sharp({
    create: {
      width,
      height,
      channels: alpha ? 4 : 3,
      background: alpha ? { r: 0, g: 0, b: 0, alpha: 0 } : { r: 200, g: 50, b: 50 },
    },
  })
    [format]()
    .toBuffer();

describe('makeThumbnail', () => {
  it('기본은 긴 변을 THUMBNAIL_DEFAULT_PX 로 줄이고 비율을 지킨 JPEG 를 만든다', async () => {
    const meta = await sharp(await makeThumbnail(await image(1000, 500, 'png'))).metadata();
    expect(meta.format).toBe('jpeg');
    expect([meta.width, meta.height]).toEqual([THUMBNAIL_DEFAULT_PX, THUMBNAIL_DEFAULT_PX / 2]);
  });

  it('세로로 긴 사진도 긴 변 기준이다', async () => {
    const meta = await sharp(await makeThumbnail(await image(600, 1200, 'jpeg'))).metadata();
    expect([meta.width, meta.height]).toEqual([THUMBNAIL_DEFAULT_PX / 2, THUMBNAIL_DEFAULT_PX]);
  });

  it('부르는 쪽이 정한 크기로 줄인다', async () => {
    const meta = await sharp(await makeThumbnail(await image(1000, 500, 'png'), 96)).metadata();
    expect([meta.width, meta.height]).toEqual([96, 48]);
  });

  it.each([31, 1025, 100.5, Number.NaN])(
    '범위(32~1024 정수) 밖의 크기(%s)는 던진다',
    async (maxPx) => {
      await expect(makeThumbnail(await image(100, 50, 'png'), maxPx)).rejects.toThrow(
        '썸네일 크기',
      );
    },
  );

  it('작은 이미지는 키우지 않는다', async () => {
    const meta = await sharp(await makeThumbnail(await image(100, 50, 'jpeg'))).metadata();
    expect([meta.width, meta.height]).toEqual([100, 50]);
  });

  it('EXIF 방향대로 돌리고 메타데이터는 남기지 않는다', async () => {
    // 방향 6 = 시계 방향 90도. 400×200 으로 저장된 사진은 200×400 으로 보여야 한다
    const rotated = await sharp(await image(400, 200, 'jpeg'))
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const meta = await sharp(await makeThumbnail(rotated)).metadata();
    expect([meta.width, meta.height]).toEqual([160, 320]);
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
  });

  it('투명한 PNG 는 흰 바탕 JPEG 가 된다', async () => {
    const thumb = await makeThumbnail(await image(10, 10, 'png', true));
    const { data } = await sharp(thumb).raw().toBuffer({ resolveWithObject: true });
    expect([data[0], data[1], data[2]]).toEqual([255, 255, 255]);
  });

  it('깨진 이미지는 던진다', async () => {
    const broken = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    await expect(makeThumbnail(broken)).rejects.toThrow();
  });

  it('입력 픽셀 상한을 넘으면 던진다 — 압축 폭탄', async () => {
    const side = Math.ceil(Math.sqrt(THUMBNAIL_MAX_INPUT_PIXELS)) + 1;
    const huge = await sharp({
      create: { width: side, height: side, channels: 3, background: '#fff' },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    await expect(makeThumbnail(huge)).rejects.toThrow();
  });
});
```

- [ ] **Step 3: 실패 확인** — `corepack pnpm test thumbnail` → `Cannot find module './thumbnail'`

- [ ] **Step 4: 구현**

```ts
// src/storage/thumbnail.ts
import sharp from 'sharp';

/** 업무가 크기를 정하지 않을 때의 썸네일 긴 변(px). */
export const THUMBNAIL_DEFAULT_PX = 320;
/** 업무가 정할 수 있는 썸네일 긴 변의 범위(px). 실수로 원본만 한 사본을 만들지 않게 막는다. */
export const THUMBNAIL_MIN_PX = 32;
export const THUMBNAIL_LIMIT_PX = 1024;
/** 썸네일 JPEG 품질. */
export const THUMBNAIL_QUALITY = 80;
/** 이보다 픽셀이 많은 이미지는 줄이지 않고 던진다 — 작은 파일이 메모리를 터뜨리는 압축 폭탄 방지. */
export const THUMBNAIL_MAX_INPUT_PIXELS = 40_000_000;

/**
 * JPG · PNG 원본을 긴 변 maxPx 안의 JPEG 로 줄인다. 작으면 키우지 않는다. maxPx 는 32~1024 정수.
 * EXIF 방향대로 돌리고 메타데이터(위치 포함)는 버린다. 투명 영역은 흰 바탕. 깨진 이미지는 던진다.
 */
export async function makeThumbnail(
  body: Buffer,
  maxPx = THUMBNAIL_DEFAULT_PX,
): Promise<Buffer> {
  if (!Number.isInteger(maxPx) || maxPx < THUMBNAIL_MIN_PX || maxPx > THUMBNAIL_LIMIT_PX)
    throw new Error(
      `썸네일 크기는 ${THUMBNAIL_MIN_PX}~${THUMBNAIL_LIMIT_PX}px 정수여야 합니다: ${maxPx}`,
    );
  return sharp(body, { limitInputPixels: THUMBNAIL_MAX_INPUT_PIXELS })
    .rotate()
    .resize({
      width: maxPx,
      height: maxPx,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: THUMBNAIL_QUALITY })
    .toBuffer();
}
```

- [ ] **Step 5: 통과 확인** — `corepack pnpm test thumbnail` → 12 passed. 압축 폭탄 테스트가 느리면(5초 넘게) 보고한다.

- [ ] **Step 6: 커밋**

```bash
git add package.json pnpm-lock.yaml src/storage/thumbnail.ts src/storage/thumbnail.spec.ts
git commit -m "feat(storage): 첨부 이미지 썸네일 만들기(sharp)"
```

---

### Task 2: StorageService — 썸네일 키 · put 옵션 · thumbnailUrl · delete

**Files:**
- Modify: `src/storage/storage.service.ts`, `src/storage/storage.service.spec.ts`

**Interfaces:**
- Consumes: `makeThumbnail` (Task 1)
- Produces:
  - `StorageService.thumbnailKey(key: string): string` (static) — 원본 이미지 키 → `.thumb.jpg` 키. PDF · 썸네일 키 · 형식 밖이면 던진다
  - `type ThumbnailOption = boolean | { maxPx: number }`
  - `put(key: string, body: Buffer, kind: FileKind, options?: { thumbnail?: ThumbnailOption }): Promise<void>` — `true` 면 기본 크기, `{ maxPx }` 면 그 크기
  - `thumbnailUrl(key: string): Promise<string>` — 원본 키를 받아 썸네일 300초 주소
  - `delete(key: string): Promise<void>` — 이미지면 썸네일 → 원본

- [ ] **Step 1: 실패하는 테스트** — `storage.service.spec.ts` 에 더한다. 기존 `fakeS3`(send 를 jest.fn 으로)와 실제 모양 키 도우미를 쓴다. 테스트 이미지는 sharp 로 만든다.

```ts
import sharp from 'sharp';
// …
const png = () =>
  sharp({ create: { width: 800, height: 400, channels: 3, background: '#c33' } }).png().toBuffer();
const UUID = '0b8f6c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e';

describe('StorageService.thumbnailKey', () => {
  it.each([
    [`inquiries/1/${UUID}.png`, `inquiries/1/${UUID}.thumb.jpg`],
    [`stores/7/${UUID}.jpg`, `stores/7/${UUID}.thumb.jpg`],
  ])('%s → %s', (key, thumb) => {
    expect(StorageService.thumbnailKey(key)).toBe(thumb);
  });

  it.each([
    `inquiries/1/${UUID}.pdf`,
    `inquiries/1/${UUID}.thumb.jpg`,
    `images/1/${UUID}.png`,
    'inquiries/1/a.png',
  ])('PDF · 썸네일 키 · 형식 밖(%s)은 던진다', (key) => {
    expect(() => StorageService.thumbnailKey(key)).toThrow();
  });
});

describe('썸네일 키도 assertKey 를 받는다', () => {
  it('썸네일 키는 delete 할 수 있지만 다른 모양은 막는다', async () => {
    const { s3, send } = fakeS3();
    const service = new StorageService(s3, BUCKET);
    for (const bad of [
      `inquiries/1/${UUID}.thumb.png`,
      `inquiries/1/${UUID}.thumb.pdf`,
      `images/1/${UUID}.thumb.jpg`,
      `attachments/1/${UUID}.thumb.jpg`,
    ]) {
      await expect(service.delete(bad)).rejects.toThrow('저장소 키 형식이 아닙니다');
    }
    expect(send).not.toHaveBeenCalled();
  });
});

describe('StorageService.put — 썸네일', () => {
  const key = `inquiries/1/${UUID}.png`;

  it('옵션이 켜지면 원본 다음에 썸네일(JPEG)을 올린다', async () => {
    const { s3, send } = fakeS3();
    await new StorageService(s3, BUCKET).put(key, await png(), 'PNG', { thumbnail: true });

    const inputs = send.mock.calls.map(([c]) => (c as PutObjectCommand).input);
    expect(inputs.map((i) => [i.Key, i.ContentType])).toEqual([
      [key, 'image/png'],
      [`inquiries/1/${UUID}.thumb.jpg`, 'image/jpeg'],
    ]);
    const meta = await sharp(inputs[1].Body as Buffer).metadata();
    expect(meta.width).toBe(320);
  });

  it('업무가 정한 크기로 썸네일을 만든다', async () => {
    const { s3, send } = fakeS3();
    await new StorageService(s3, BUCKET).put(key, await png(), 'PNG', {
      thumbnail: { maxPx: 96 },
    });
    const thumb = (send.mock.calls[1][0] as PutObjectCommand).input.Body as Buffer;
    expect((await sharp(thumb).metadata()).width).toBe(96);
  });

  it('범위 밖 크기는 S3 를 부르기 전에 던진다', async () => {
    const { s3, send } = fakeS3();
    await expect(
      new StorageService(s3, BUCKET).put(key, await png(), 'PNG', {
        thumbnail: { maxPx: 2000 },
      }),
    ).rejects.toThrow('썸네일 크기');
    expect(send).not.toHaveBeenCalled();
  });

  it('옵션이 없으면 원본만 올린다', async () => {
    const { s3, send } = fakeS3();
    await new StorageService(s3, BUCKET).put(key, await png(), 'PNG');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('PDF 는 옵션이 켜져 있어도 썸네일을 만들지 않는다', async () => {
    const { s3, send } = fakeS3();
    await new StorageService(s3, BUCKET).put(
      `inquiries/1/${UUID}.pdf`, Buffer.from('%PDF-1.7'), 'PDF', { thumbnail: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('깨진 이미지는 S3 를 부르기 전에 던진다', async () => {
    const { s3, send } = fakeS3();
    const broken = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    await expect(
      new StorageService(s3, BUCKET).put(key, broken, 'PNG', { thumbnail: true }),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('썸네일 올리기가 실패하면 올린 원본을 지우고 원래 오류를 던진다', async () => {
    const { s3, send } = fakeS3();
    send
      .mockResolvedValueOnce({}) // 원본
      .mockRejectedValueOnce(new Error('SlowDown')) // 썸네일
      .mockResolvedValueOnce({}); // 원본 지우기
    await expect(
      new StorageService(s3, BUCKET).put(key, await png(), 'PNG', { thumbnail: true }),
    ).rejects.toThrow('SlowDown');
    const last = send.mock.calls[2][0] as DeleteObjectCommand;
    expect(last).toBeInstanceOf(DeleteObjectCommand);
    expect(last.input.Key).toBe(key);
  });
});

describe('StorageService.delete — 썸네일', () => {
  it('이미지는 썸네일을 먼저, 원본을 나중에 지운다', async () => {
    const { s3, send } = fakeS3();
    await new StorageService(s3, BUCKET).delete(`inquiries/1/${UUID}.jpg`);
    expect(send.mock.calls.map(([c]) => (c as DeleteObjectCommand).input.Key)).toEqual([
      `inquiries/1/${UUID}.thumb.jpg`,
      `inquiries/1/${UUID}.jpg`,
    ]);
  });

  it('썸네일 지우기가 실패하면 원본도 지우지 않고 던진다', async () => {
    const { s3, send } = fakeS3();
    send.mockRejectedValueOnce(new Error('AccessDenied'));
    await expect(
      new StorageService(s3, BUCKET).delete(`inquiries/1/${UUID}.jpg`),
    ).rejects.toThrow('AccessDenied');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('PDF 는 원본만 지운다', async () => {
    const { s3, send } = fakeS3();
    await new StorageService(s3, BUCKET).delete(`inquiries/1/${UUID}.pdf`);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('StorageService.thumbnailUrl', () => {
  it('원본 키를 받아 썸네일 키의 300초 주소를 준다', async () => {
    const s3 = new S3Client({
      region: 'ap-northeast-2',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
    });
    const url = new URL(
      await new StorageService(s3, BUCKET).thumbnailUrl(`inquiries/1/${UUID}.png`),
    );
    expect(url.pathname).toBe(`/inquiries/1/${UUID}.thumb.jpg`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
  });

  it('PDF 키는 던진다', async () => {
    const { s3 } = fakeS3();
    await expect(
      new StorageService(s3, BUCKET).thumbnailUrl(`inquiries/1/${UUID}.pdf`),
    ).rejects.toThrow();
  });
});
```

기존 `delete` 테스트(이미지 키 하나만 지운다고 본 것)가 있으면 PDF 키로 바꾸거나 위 순서 테스트로 옮긴다.

- [ ] **Step 2: 실패 확인** — `corepack pnpm test storage.service`

- [ ] **Step 3: 구현** — `storage.service.ts`

```ts
import { makeThumbnail } from './thumbnail';

// newKey 가 만드는 원본 키와, 거기서 이끌어 낸 썸네일 키(.thumb.jpg). put · downloadUrl · delete 는 이 모양만 받는다.
const KEY_PATTERN =
  /^([a-z0-9][a-z0-9-]*)\/\d+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.(?:jpg|png|pdf)|\.thumb\.jpg)$/;
const IMAGE_KEY = /\.(?:jpg|png)$/;
const THUMB_SUFFIX = '.thumb.jpg';

/** put 의 썸네일 옵션. true 면 기본 크기, { maxPx } 면 그 긴 변(px). */
export type ThumbnailOption = boolean | { maxPx: number };

  /** 원본 이미지 키 → 썸네일 키. PDF · 썸네일 키 · 형식 밖은 던진다. */
  static thumbnailKey(key: string): string {
    StorageService.assertKey(key);
    if (key.endsWith(THUMB_SUFFIX) || !IMAGE_KEY.test(key))
      throw new Error(`썸네일이 없는 키입니다: ${key}`);
    return key.replace(IMAGE_KEY, THUMB_SUFFIX);
  }

  /**
   * 원본을 올린다. thumbnail 이 켜져 있고 JPG · PNG 면 줄인 사본(.thumb.jpg)도 올린다 — PDF 는 건너뛴다.
   * thumbnail: true 면 기본 크기, { maxPx } 면 업무가 정한 긴 변(px).
   * 사본을 먼저 만들어 깨진 이미지면 아무것도 올리지 않고, 사본 올리기가 실패하면 원본을 지운다.
   */
  async put(
    key: string,
    body: Buffer,
    kind: FileKind,
    options: { thumbnail?: ThumbnailOption } = {},
  ): Promise<void> {
    StorageService.assertKey(key);
    const { thumbnail: option } = options;
    const thumbnail =
      option && kind !== 'PDF'
        ? await makeThumbnail(body, option === true ? undefined : option.maxPx)
        : null;
    await this.putObject(key, body, CONTENT_TYPES[kind]);
    if (!thumbnail) return;
    try {
      await this.putObject(StorageService.thumbnailKey(key), thumbnail, 'image/jpeg');
    } catch (error) {
      await this.deleteObject(key);
      throw error;
    }
  }

  /** 원본 키를 받아 썸네일의 300초 주소를 준다. 목록 화면용. 권한을 확인한 뒤 부른다. */
  async thumbnailUrl(key: string): Promise<string> {
    const thumbKey = StorageService.thumbnailKey(key);
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.bucket, Key: thumbKey }),
      { expiresIn: DOWNLOAD_URL_SECONDS },
    );
  }

  /** 이미지면 썸네일을 먼저 지운다 — 중간에 실패해도 사본만 남지 않게. 없는 썸네일 삭제는 S3 가 성공으로 본다. */
  async delete(key: string): Promise<void> {
    StorageService.assertKey(key);
    if (IMAGE_KEY.test(key) && !key.endsWith(THUMB_SUFFIX))
      await this.deleteObject(StorageService.thumbnailKey(key));
    await this.deleteObject(key);
  }

  private async putObject(key: string, body: Buffer, contentType: string) {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  private async deleteObject(key: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
```

`thumbnailUrl` 의 `thumbnailKey` 가 동기로 던지면 async 함수라 reject 로 바뀐다(위 PDF 테스트가 그것을 본다).

- [ ] **Step 4: 통과 확인** — `corepack pnpm test storage`, `corepack pnpm exec tsc --noEmit -p tsconfig.json`, `corepack pnpm lint`(오류 0), `corepack pnpm build`, 전체 `corepack pnpm test` 한 번.

- [ ] **Step 5: 커밋**

```bash
git add src/storage/storage.service.ts src/storage/storage.service.spec.ts
git commit -m "feat(storage): 썸네일 올리기 · 주소 · 함께 지우기"
```

---

### Task 3: 실제 버킷 확인 · Linux 설치 확인 · 문서

**Files:**
- Modify: `okf/api/storage.md`, `okf/log.md`

- [ ] **Step 1: 실제 버킷 (커밋하지 않음)** — `corepack pnpm build` 뒤 `.env.local` 로 `smoke/0/<UUID>.png` 를 `{ thumbnail: { maxPx: 128 } }` 로 올리고, `thumbnailUrl` 로 받아 `image/jpeg` · 긴 변 128 인지 보고, `delete` 뒤 `aws s3 ls s3://whale-erp-files/smoke/` 가 비었는지 본다. 키 값은 출력하지 않는다.

- [ ] **Step 2: 배포 환경 확인은 배포 담당자(유상욱)에게 맡긴다 (코드 작업 없음)** — 컨트롤러가 PR 을 올린 뒤 재영 확인을 받아 요청한다. 요청 내용: 배포 환경 안에서(Docker 면 이미지 빌드 단계에서) `pnpm install --frozen-lockfile` 을 돌리고 `node -e "require('sharp')"` 가 오류 없이 끝나는지 확인. Mac 에서 깐 `node_modules` 를 복사하지 않는다. sharp 0.35.5 는 install 스크립트가 없어 `allowBuilds` 에 더할 것이 없고, Linux x64 · arm64(glibc · musl) · macOS · Windows x64 는 미리 빌드된 바이너리가 있어 libvips 설치가 필요 없다. 이 Step 에서 구현자가 할 일은 없다.

- [ ] **Step 3: 문서** — `okf/api/storage.md` 「Rules a caller must keep」에: `put(key, buffer, kind, { thumbnail: { maxPx } })` 는 JPG · PNG 에만 긴 변 maxPx(32~1024, `true` 면 320) JPEG 사본을 만든다(PDF 건너뜀). 크기는 화면 크기의 2배 정도로 업무가 정한다, 목록은 `thumbnailUrl(key)`, 상세는 `downloadUrl`, `delete` 가 둘 다 지운다, 썸네일을 켤지는 업무마다 늘 같게(켠 업무의 이미지에만 `thumbnailUrl` 을 부른다). Configuration 에 sharp 는 플랫폼별 바이너리라 배포 환경 안에서 `pnpm install` 해야 한다는 줄(로컬은 각자 `pnpm install` 이면 되고, 이 변경을 받은 뒤 설치하지 않으면 `Cannot find module 'sharp'`). `generated.at` · `sources[].last_modified` 갱신, 새 source 로 `src/storage/thumbnail.ts`. `okf/log.md` 2026-10-14 에 한 줄.

- [ ] **Step 4: 커밋**

```bash
git add okf/api/storage.md okf/log.md
git commit -m "docs(okf): 첨부 이미지 썸네일"
```

---

## 이 계획 밖

- 보존 기간 파기(#323) 배치가 `delete(key)` 를 부르게 하는 일 — 파기 배치 쪽 일감에서 한다. `delete` 하나로 원본 · 썸네일이 함께 지워지므로 따로 할 것은 없다.
- 업무별 사용: 문의사항 첨부(#281)와 점포 이미지(1팀 답 대기)가 `{ thumbnail: { maxPx } }` 와 `thumbnailUrl` 을 쓴다. 크기는 각 업무가 화면 크기(점포 카드 96px, 문의 상세 64px)의 2배 정도로 정한다.
- inline 서명, 확대 화면, 만료 대응 — 재영 결정 대기.
