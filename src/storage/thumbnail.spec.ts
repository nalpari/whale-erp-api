import { BadRequestException } from '@nestjs/common';
import sharp from 'sharp';
import {
  makeThumbnail,
  THUMBNAIL_DEFAULT_PX,
  THUMBNAIL_MAX_INPUT_PIXELS,
} from './thumbnail';

const image = (
  width: number,
  height: number,
  format: 'png' | 'jpeg',
  alpha = false,
) =>
  sharp({
    create: {
      width,
      height,
      channels: alpha ? 4 : 3,
      background: alpha
        ? { r: 0, g: 0, b: 0, alpha: 0 }
        : { r: 200, g: 50, b: 50 },
    },
  })
    [format]()
    .toBuffer();

describe('makeThumbnail', () => {
  it('기본은 긴 변을 THUMBNAIL_DEFAULT_PX 로 줄이고 비율을 지킨 JPEG 를 만든다', async () => {
    const meta = await sharp(
      await makeThumbnail(await image(1000, 500, 'png')),
    ).metadata();
    expect(meta.format).toBe('jpeg');
    expect([meta.width, meta.height]).toEqual([
      THUMBNAIL_DEFAULT_PX,
      THUMBNAIL_DEFAULT_PX / 2,
    ]);
  });

  it('세로로 긴 사진도 긴 변 기준이다', async () => {
    const meta = await sharp(
      await makeThumbnail(await image(600, 1200, 'jpeg')),
    ).metadata();
    expect([meta.width, meta.height]).toEqual([
      THUMBNAIL_DEFAULT_PX / 2,
      THUMBNAIL_DEFAULT_PX,
    ]);
  });

  it('부르는 쪽이 정한 크기로 줄인다', async () => {
    const meta = await sharp(
      await makeThumbnail(await image(1000, 500, 'png'), 96),
    ).metadata();
    expect([meta.width, meta.height]).toEqual([96, 48]);
  });

  it.each([31, 1025, 100.5, Number.NaN])(
    '범위(32~1024 정수) 밖의 크기(%s)는 던진다',
    async (maxPx) => {
      await expect(
        makeThumbnail(await image(100, 50, 'png'), maxPx),
      ).rejects.toThrow('썸네일 크기');
    },
  );

  it('범위 밖 크기는 HTTP 오류가 아닌 일반 Error 다', async () => {
    const error: unknown = await makeThumbnail(
      await image(100, 50, 'png'),
      5,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(BadRequestException);
  });

  it('작은 이미지는 키우지 않는다', async () => {
    const meta = await sharp(
      await makeThumbnail(await image(100, 50, 'jpeg')),
    ).metadata();
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
    const { data } = await sharp(thumb)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([data[0], data[1], data[2]]).toEqual([255, 255, 255]);
  });

  it('깨진 이미지는 던진다', async () => {
    const broken = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]);
    const error: unknown = await makeThumbnail(broken).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toBe('이미지를 읽을 수 없습니다.');
  });

  it('입력 픽셀 상한을 넘으면 던진다 — 압축 폭탄', async () => {
    const side = Math.ceil(Math.sqrt(THUMBNAIL_MAX_INPUT_PIXELS)) + 1;
    const huge = await sharp({
      create: { width: side, height: side, channels: 3, background: '#fff' },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    const error: unknown = await makeThumbnail(huge).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toBe('이미지가 너무 큽니다.');
  });

  it('50MP 폰 사진(8160×6120)은 통과한다', async () => {
    const photo = await image(8160, 6120, 'jpeg');
    const meta = await sharp(await makeThumbnail(photo)).metadata();
    expect([meta.width, meta.height]).toEqual([320, 240]);
  });
});
