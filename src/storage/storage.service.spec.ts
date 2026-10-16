import { BadRequestException, Logger } from '@nestjs/common';
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { contentDisposition, StorageService } from './storage.service';

const BUCKET = 'whale-erp-files';
const UUID = '0b8f3c1e-5d2a-4f6b-9c7d-1a2b3c4d5e6f';
const KEY = `inquiries/1/${UUID}.pdf`;

function fakeS3() {
  const send = jest
    .fn<Promise<object>, [object, object?]>()
    .mockResolvedValue({});
  return { s3: { send } as unknown as S3Client, send };
}

describe('StorageService.newKey', () => {
  it.each([
    ['JPG', 'jpg'],
    ['PNG', 'png'],
    ['PDF', 'pdf'],
  ] as const)(
    '{도메인}/{ID}/{UUID}.{확장자} 로 만든다 — %s 는 .%s',
    (kind, ext) => {
      expect(StorageService.newKey('inquiries', 12, kind)).toMatch(
        new RegExp(`^inquiries/12/[0-9a-f-]{36}\\.${ext}$`),
      );
    },
  );

  it('0 은 받고, 소유자 ID 가 NaN · 음수 · 소수면 던진다', () => {
    expect(() => StorageService.newKey('smoke', 0, 'PNG')).not.toThrow();
    for (const id of [NaN, -1, 1.5])
      expect(() => StorageService.newKey('inquiries', id, 'PNG')).toThrow();
  });

  it.each(['images', 'attachments'])(
    '1차가 쓰던 맨 앞 폴더(%s)는 쓰지 않는다 — images/ 는 공개 정책이 걸려 있다',
    (domain) => {
      expect(() => StorageService.newKey(domain, 1, 'PNG')).toThrow(domain);
    },
  );

  it.each(['Inquiries', 'a/b', '..', '', 'store images'])(
    '소문자 · 숫자 · - 가 아닌 도메인 이름(%s)은 던진다',
    (domain) => {
      expect(() => StorageService.newKey(domain, 1, 'PNG')).toThrow();
    },
  );
});

describe('StorageService.put · delete', () => {
  it('put 은 버킷 · 키 · Content-Type 을 넣어 보낸다', async () => {
    const { s3, send } = fakeS3();
    const body = Buffer.from('%PDF-1.7');

    await new StorageService(s3, BUCKET).put(KEY, body, 'PDF');

    const command = send.mock.calls[0][0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toEqual({
      Bucket: BUCKET,
      Key: KEY,
      Body: body,
      ContentType: 'application/pdf',
    });
    // 멈춘 요청이 매달리지 않게 재시도까지 포함한 전체 기한을 건다
    const options = (send.mock.calls[0] as unknown[])[1] as {
      abortSignal: AbortSignal;
    };
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    expect(options.abortSignal.aborted).toBe(false);
  });

  it.each([
    ['JPG', 'image/jpeg'],
    ['PNG', 'image/png'],
  ] as const)(
    'put 의 Content-Type 은 종류에서 온다 — %s',
    async (kind, type) => {
      const { s3, send } = fakeS3();
      await new StorageService(s3, BUCKET).put(
        StorageService.newKey('x', 1, kind),
        Buffer.alloc(1),
        kind,
      );
      expect(
        (send.mock.calls[0][0] as PutObjectCommand).input.ContentType,
      ).toBe(type);
    },
  );

  it('delete 는 그 키 하나만 지운다', async () => {
    const { s3, send } = fakeS3();

    await new StorageService(s3, BUCKET).delete(KEY);

    const command = send.mock.calls[0][0] as DeleteObjectCommand;
    expect(command).toBeInstanceOf(DeleteObjectCommand);
    expect(command.input).toEqual({ Bucket: BUCKET, Key: KEY });
    // 올리기와 같은 기한 — 정리가 S3 무응답에 매달리지 않게
    expect(
      ((send.mock.calls[0] as unknown[])[1] as { abortSignal: AbortSignal })
        .abortSignal,
    ).toBeInstanceOf(AbortSignal);
  });

  it('delete(key, { thumbnail: false }) 는 이미지여도 원본만 지운다 — 썸네일 없이 올린 파일', async () => {
    const { s3, send } = fakeS3();
    const png = `contracts/1/${UUID}.png`;
    await new StorageService(s3, BUCKET).delete(png, { thumbnail: false });
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0][0] as DeleteObjectCommand).input.Key).toBe(png);
  });

  it('S3 오류는 그대로 올린다 — 호출부가 처리한다', async () => {
    const { s3, send } = fakeS3();
    send.mockRejectedValue(new Error('AccessDenied'));

    await expect(
      new StorageService(s3, BUCKET).put(KEY, Buffer.alloc(1), 'PDF'),
    ).rejects.toThrow('AccessDenied');
  });
});

describe('키 검사 — put · downloadUrl · delete', () => {
  const BAD = [
    `attachments/1/${UUID}.pdf`,
    `images/1/${UUID}.png`,
    `inquiries/1/../x.pdf`,
    `inquiries/abc/${UUID}.pdf`,
    'inquiries/1/foo.pdf',
    `Inquiries/1/${UUID}.pdf`,
  ];

  it.each(['JPG', 'PNG', 'PDF'] as const)(
    'newKey 가 만든 키는 통과한다 — %s',
    async (kind) => {
      const { s3, send } = fakeS3();
      await new StorageService(s3, BUCKET).put(
        StorageService.newKey('inquiries', 7, kind),
        Buffer.alloc(1),
        kind,
      );
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it.each(BAD)(
    '%s 는 세 메서드 모두 거절하고 S3 를 부르지 않는다',
    async (key) => {
      const { s3, send } = fakeS3();
      const svc = new StorageService(s3, BUCKET);
      const msg = `저장소 키 형식이 아닙니다: ${key}`;

      await expect(svc.put(key, Buffer.alloc(1), 'PDF')).rejects.toThrow(msg);
      await expect(svc.downloadUrl(key, 'a.pdf')).rejects.toThrow(msg);
      await expect(svc.delete(key)).rejects.toThrow(msg);
      expect(send).not.toHaveBeenCalled();
    },
  );
});

describe('StorageService.downloadUrl', () => {
  // 서명은 가짜 키로도 만들어진다. 네트워크는 쓰지 않는다.
  const s3 = new S3Client({
    region: 'ap-northeast-2',
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
  });

  it('300초짜리 presigned GET 이고 원래 파일 이름으로 내려받게 한다', async () => {
    const url = new URL(
      await new StorageService(s3, BUCKET).downloadUrl(KEY, '계약서.pdf'),
    );

    expect(url.hostname).toBe(`${BUCKET}.s3.ap-northeast-2.amazonaws.com`);
    expect(url.pathname).toBe(`/${KEY}`);
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

describe('contentDisposition — 서로게이트', () => {
  it('짝 없는 서로게이트는 U+FFFD 로 바꿔 던지지 않는다', () => {
    expect(contentDisposition('a\uD800b.pdf')).toContain('%EF%BF%BD');
    expect(contentDisposition('a\uDC00b.pdf')).toContain('%EF%BF%BD');
  });

  it('짝이 맞는 이모지는 그대로 인코딩한다', () => {
    expect(contentDisposition('😀.pdf')).toContain('%F0%9F%98%80');
  });
});

const png = () =>
  sharp({
    create: { width: 800, height: 400, channels: 3, background: '#c33' },
  })
    .png()
    .toBuffer();

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
      await expect(service.delete(bad)).rejects.toThrow(
        '저장소 키 형식이 아닙니다',
      );
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('썸네일 키 자체는 delete 로 하나만 지운다', async () => {
    const { s3, send } = fakeS3();
    await new StorageService(s3, BUCKET).delete(
      `inquiries/1/${UUID}.thumb.jpg`,
    );
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('StorageService.put — 썸네일', () => {
  const key = `inquiries/1/${UUID}.png`;

  it('옵션이 켜지면 원본 다음에 썸네일(JPEG)을 올린다', async () => {
    const { s3, send } = fakeS3();
    await new StorageService(s3, BUCKET).put(key, await png(), 'PNG', {
      thumbnail: true,
    });

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
    const thumb = (send.mock.calls[1][0] as PutObjectCommand).input
      .Body as Buffer;
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
      `inquiries/1/${UUID}.pdf`,
      Buffer.from('%PDF-1.7'),
      'PDF',
      { thumbnail: true },
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('깨진 이미지는 S3 를 부르기 전에 던진다', async () => {
    const { s3, send } = fakeS3();
    const broken = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]);
    await expect(
      new StorageService(s3, BUCKET).put(key, broken, 'PNG', {
        thumbnail: true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(send).not.toHaveBeenCalled();
  });

  it('썸네일 올리기가 실패하면 썸네일 → 원본 순으로 지우고 원래 오류를 던진다', async () => {
    const { s3, send } = fakeS3();
    send
      .mockResolvedValueOnce({}) // 원본
      .mockRejectedValueOnce(new Error('SlowDown')) // 썸네일
      .mockResolvedValueOnce({}) // 썸네일 지우기
      .mockResolvedValueOnce({}); // 원본 지우기
    await expect(
      new StorageService(s3, BUCKET).put(key, await png(), 'PNG', {
        thumbnail: true,
      }),
    ).rejects.toThrow('SlowDown');
    const deletes = [2, 3].map(
      (i) => send.mock.calls[i][0] as DeleteObjectCommand,
    );
    deletes.forEach((d) => expect(d).toBeInstanceOf(DeleteObjectCommand));
    expect(deletes.map((d) => d.input.Key)).toEqual([
      `inquiries/1/${UUID}.thumb.jpg`,
      key,
    ]);
  });

  it.each([
    [`inquiries/1/${UUID}.pdf`, 'JPG'],
    [`inquiries/1/${UUID}.png`, 'JPG'],
    [`inquiries/1/${UUID}.jpg`, 'PDF'],
  ] as const)(
    '키 확장자와 종류가 다르면(%s · %s) S3 를 부르기 전에 던진다',
    async (badKey, kind) => {
      const { s3, send } = fakeS3();
      await expect(
        new StorageService(s3, BUCKET).put(badKey, Buffer.alloc(1), kind),
      ).rejects.toThrow(
        `키 확장자와 파일 종류가 다릅니다: ${badKey} (${kind})`,
      );
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('썸네일 키는 원본으로 올릴 수 없다', async () => {
    const { s3, send } = fakeS3();
    await expect(
      new StorageService(s3, BUCKET).put(
        `inquiries/1/${UUID}.thumb.jpg`,
        Buffer.alloc(1),
        'JPG',
      ),
    ).rejects.toThrow('썸네일 키에는 원본을 올릴 수 없습니다');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('StorageService.put — 정리 실패', () => {
  it('정리 삭제가 모두 실패해도 썸네일 오류가 올라오고 남은 키를 경고한다', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { s3, send } = fakeS3();
    send
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('SlowDown'))
      .mockRejectedValueOnce(new Error('AccessDenied'))
      .mockRejectedValueOnce(new Error('AccessDenied'));
    const key = `inquiries/1/${UUID}.png`;
    await expect(
      new StorageService(s3, BUCKET).put(key, await png(), 'PNG', {
        thumbnail: true,
      }),
    ).rejects.toThrow('SlowDown');
    const warned = warn.mock.calls.map(([m]) => String(m));
    expect(warned).toHaveLength(2);
    expect(warned[0]).toContain(`${UUID}.thumb.jpg`);
    expect(warned[1]).toContain(key);
    // 원인(S3 오류 이름 · 메시지)을 키 옆에 남긴다.
    for (const m of warned) expect(m).toContain('Error: AccessDenied');
    warn.mockRestore();
  });
});

describe('StorageService.delete — 썸네일', () => {
  it('PDF 는 원본만 지운다', async () => {
    const { s3, send } = fakeS3();
    await new StorageService(s3, BUCKET).delete(`inquiries/1/${UUID}.pdf`);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('이미지는 썸네일을 먼저, 원본을 나중에 지운다', async () => {
    const { s3, send } = fakeS3();
    await new StorageService(s3, BUCKET).delete(`inquiries/1/${UUID}.jpg`);
    expect(
      send.mock.calls.map(([c]) => (c as DeleteObjectCommand).input.Key),
    ).toEqual([`inquiries/1/${UUID}.thumb.jpg`, `inquiries/1/${UUID}.jpg`]);
  });

  it('썸네일 지우기가 실패하면 원본도 지우지 않고 던진다', async () => {
    const { s3, send } = fakeS3();
    send.mockRejectedValueOnce(new Error('AccessDenied'));
    await expect(
      new StorageService(s3, BUCKET).delete(`inquiries/1/${UUID}.jpg`),
    ).rejects.toThrow('AccessDenied');
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
      (await new StorageService(s3, BUCKET).thumbnailUrl(
        `inquiries/1/${UUID}.png`,
      ))!,
    );
    expect(url.pathname).toBe(`/inquiries/1/${UUID}.thumb.jpg`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
  });

  it('PDF 키는 null 이고 S3 를 부르지 않는다', async () => {
    const { s3, send } = fakeS3();
    await expect(
      new StorageService(s3, BUCKET).thumbnailUrl(`inquiries/1/${UUID}.pdf`),
    ).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('썸네일 키 · 형식 밖 키는 던진다', async () => {
    const { s3 } = fakeS3();
    const svc = new StorageService(s3, BUCKET);
    await expect(
      svc.thumbnailUrl(`inquiries/1/${UUID}.thumb.jpg`),
    ).rejects.toThrow();
    await expect(svc.thumbnailUrl('inquiries/1/a.png')).rejects.toThrow();
  });
});
