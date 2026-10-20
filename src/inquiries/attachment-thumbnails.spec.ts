import { Logger } from '@nestjs/common';
import type { StorageService } from '../storage/storage.service';
import { withThumbnails } from './attachment-thumbnails';

describe('withThumbnails — 문의 첨부의 작은 미리보기 주소(#277 · #284)', () => {
  const rows = [
    {
      inquiryAttachmentId: 1,
      fileType: 'PNG',
      storageKey: 'inquiries/7/a.png',
    },
    {
      inquiryAttachmentId: 2,
      fileType: 'PDF',
      storageKey: 'inquiries/7/b.pdf',
    },
  ];
  const warn = jest.fn();
  const logger = { warn } as unknown as Logger;
  let thumbnailUrl: jest.Mock;
  let storage: StorageService;

  beforeEach(() => {
    jest.clearAllMocks();
    thumbnailUrl = jest.fn((key: string) =>
      Promise.resolve(key.endsWith('.pdf') ? null : `https://s3/${key}.thumb`),
    );
    storage = { thumbnailUrl } as unknown as StorageService;
  });

  it('이미지는 썸네일 주소, PDF 는 null 을 싣고 저장 키는 빼고 준다', async () => {
    await expect(withThumbnails(storage, rows, logger)).resolves.toEqual([
      {
        inquiryAttachmentId: 1,
        fileType: 'PNG',
        thumbnailUrl: 'https://s3/inquiries/7/a.png.thumb',
      },
      { inquiryAttachmentId: 2, fileType: 'PDF', thumbnailUrl: null },
    ]);
  });

  it('저장소 설정이 없으면 모두 null — 상세는 그대로 보인다', async () => {
    await expect(withThumbnails(null, rows, logger)).resolves.toEqual([
      expect.objectContaining({ inquiryAttachmentId: 1, thumbnailUrl: null }),
      expect.objectContaining({ inquiryAttachmentId: 2, thumbnailUrl: null }),
    ]);
  });

  it('서명이 실패한 첨부는 null 이고, 몇 건인지 경고 한 줄로 남긴다', async () => {
    thumbnailUrl.mockRejectedValue(new Error('no credentials'));
    const result = await withThumbnails(storage, rows, logger);
    expect(result.map((r) => r.thumbnailUrl)).toEqual([null, null]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('2/2건'));
  });

  it('일부만 실패하면 그 첨부만 null 이고 나머지 주소는 제자리에 남는다', async () => {
    thumbnailUrl
      .mockRejectedValueOnce(new Error('no credentials'))
      .mockResolvedValueOnce('https://s3/second');
    const result = await withThumbnails(storage, rows, logger);
    expect(result.map((r) => r.thumbnailUrl)).toEqual([
      null,
      'https://s3/second',
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('1/2건'));
  });

  it('첨부가 없으면 저장소를 부르지 않는다', async () => {
    await expect(withThumbnails(storage, [], logger)).resolves.toEqual([]);
    expect(thumbnailUrl).not.toHaveBeenCalled();
  });
});
