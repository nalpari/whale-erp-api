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
  if (
    !Number.isInteger(maxPx) ||
    maxPx < THUMBNAIL_MIN_PX ||
    maxPx > THUMBNAIL_LIMIT_PX
  )
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
