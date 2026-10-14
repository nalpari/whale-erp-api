import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { contentDisposition, StorageService } from './storage.service';

const BUCKET = 'whale-erp-files';

function fakeS3() {
  const send = jest.fn<Promise<object>, [object]>().mockResolvedValue({});
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

    await new StorageService(s3, BUCKET).put('inquiries/1/a.pdf', body, 'PDF');

    const command = send.mock.calls[0][0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toEqual({
      Bucket: BUCKET,
      Key: 'inquiries/1/a.pdf',
      Body: body,
      ContentType: 'application/pdf',
    });
  });

  it.each([
    ['JPG', 'image/jpeg'],
    ['PNG', 'image/png'],
  ] as const)(
    'put 의 Content-Type 은 종류에서 온다 — %s',
    async (kind, type) => {
      const { s3, send } = fakeS3();
      await new StorageService(s3, BUCKET).put('x/1/a', Buffer.alloc(1), kind);
      expect(
        (send.mock.calls[0][0] as PutObjectCommand).input.ContentType,
      ).toBe(type);
    },
  );

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
      new StorageService(s3, BUCKET).put(
        'inquiries/1/a.pdf',
        Buffer.alloc(1),
        'PDF',
      ),
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
      await new StorageService(s3, BUCKET).downloadUrl(
        'inquiries/1/a.pdf',
        '계약서.pdf',
      ),
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
