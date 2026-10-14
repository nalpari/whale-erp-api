import { BadRequestException } from '@nestjs/common';
import sharp from 'sharp';

// 매번 다른 개인 이미지라 캐시가 쓸모없고 메모리만 잡는다.
sharp.cache(false);
// 한 장은 libvips 스레드 하나로 — libuv 풀을 scrypt · dns 와 나눠 쓴다.
sharp.concurrency(1);

/** 업무가 크기를 정하지 않을 때의 썸네일 긴 변(px). */
export const THUMBNAIL_DEFAULT_PX = 320;
/** 업무가 정할 수 있는 썸네일 긴 변의 범위(px). 실수로 원본만 한 사본을 만들지 않게 막는다. */
export const THUMBNAIL_MIN_PX = 32;
export const THUMBNAIL_LIMIT_PX = 1024;
/** 썸네일 JPEG 품질. */
export const THUMBNAIL_QUALITY = 80;
/**
 * 이보다 픽셀이 많은 이미지는 헤더만 읽고 던진다 — 작은 파일이 메모리를 터뜨리는 압축 폭탄 방지.
 * JPEG 는 줄여 읽기(shrink-on-load)라 1억 화소(50MP 폰 사진 통과), PNG 는 통째로 풀어 2500만 화소.
 */
export const THUMBNAIL_MAX_JPEG_PIXELS = 100_000_000;
export const THUMBNAIL_MAX_PNG_PIXELS = 25_000_000;
/** 한 장의 처리 시간 상한(초). 넘으면 서버 오류(500)다. */
export const THUMBNAIL_TIMEOUT_SECONDS = 10;
/** 프로세스 안에서 동시에 만드는 썸네일 수. 나머지는 줄을 선다. */
export const THUMBNAIL_CONCURRENCY = 2;

const MAX_PIXELS: Record<string, number> = {
  jpeg: THUMBNAIL_MAX_JPEG_PIXELS,
  png: THUMBNAIL_MAX_PNG_PIXELS,
};

let active = 0;
const waiting: (() => void)[] = [];

/** 지금 처리 중인 썸네일 수(테스트용). */
export const activeThumbnails = () => active;

async function acquire(): Promise<void> {
  if (active < THUMBNAIL_CONCURRENCY) {
    active++;
    return;
  }
  // 자리를 넘겨받으므로 active 는 그대로다.
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  if (next) next();
  else active--;
}

/**
 * JPG · PNG 원본을 긴 변 maxPx 안의 JPEG 로 줄인다. 작으면 키우지 않는다. maxPx 는 32~1024 정수.
 * EXIF 방향대로 돌리고 메타데이터(위치 포함)는 버린다. 투명 영역은 흰 바탕.
 * 헤더를 먼저 읽어 JPEG · PNG 가 아니거나 형식별 픽셀 상한을 넘으면 풀지 않는다.
 * 깨진 이미지 · 다른 형식 · 픽셀 상한 초과는 한글 BadRequestException(400), 시간 초과는 일반 Error(500) 다.
 * 프로세스 안에서 THUMBNAIL_CONCURRENCY 장까지만 동시에 처리한다.
 */
export async function makeThumbnail(
  body: Buffer,
  maxPx = THUMBNAIL_DEFAULT_PX,
): Promise<Buffer> {
  if (
    !Number.isInteger(maxPx) ||
    maxPx < THUMBNAIL_MIN_PX ||
    maxPx > THUMBNAIL_LIMIT_PX
  )
    throw new Error(
      `썸네일 크기는 ${THUMBNAIL_MIN_PX}~${THUMBNAIL_LIMIT_PX}px 정수여야 합니다: ${maxPx}`,
    );
  await acquire();
  try {
    return await resize(body, maxPx);
  } finally {
    release();
  }
}

async function resize(body: Buffer, maxPx: number): Promise<Buffer> {
  // 헤더만 읽는다. 픽셀 상한은 아래에서 형식별로 본다.
  const meta = await sharp(body, { failOn: 'error', limitInputPixels: false })
    .metadata()
    .catch(() => null);
  const limit = meta ? MAX_PIXELS[meta.format] : undefined;
  if (!meta || !limit)
    throw new BadRequestException('이미지를 읽을 수 없습니다.');
  if (meta.width * meta.height > limit)
    throw new BadRequestException('이미지가 너무 큽니다.');
  try {
    return await sharp(body, { failOn: 'error', limitInputPixels: limit })
      .timeout({ seconds: THUMBNAIL_TIMEOUT_SECONDS })
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
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    // 시간 초과는 이미지 탓이 아니라 서버 쪽 실패다.
    if (message.includes('timeout')) throw error;
    throw new BadRequestException(
      message.includes('pixel limit')
        ? '이미지가 너무 큽니다.'
        : '이미지를 읽을 수 없습니다.',
    );
  }
}
