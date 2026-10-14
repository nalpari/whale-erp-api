import {
  BadRequestException,
  Controller,
  Post,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  assertUpload,
  AttachmentsInterceptor,
  MAX_UPLOAD_BYTES,
} from './upload-check';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const file = (buffer: Buffer) => ({ buffer, size: buffer.length });

describe('assertUpload', () => {
  it('허용 목록에 있으면 판정한 종류를 돌려준다', () => {
    expect(assertUpload(file(PNG), ['JPG', 'PNG'])).toBe('PNG');
  });

  it('내용이 허용 목록에 없으면 400 — 확장자를 바꿔 올려도 막힌다', () => {
    expect(() =>
      assertUpload(file(Buffer.from('%PDF-1.7')), ['JPG', 'PNG']),
    ).toThrow(new BadRequestException('JPG · PNG 파일만 올릴 수 있습니다.'));
    expect(() => assertUpload(file(Buffer.from('hello')), ['PDF'])).toThrow(
      BadRequestException,
    );
  });

  it('크기를 넘으면 400', () => {
    expect(() => assertUpload(file(PNG), ['PNG'], PNG.length - 1)).toThrow(
      new BadRequestException(
        `파일은 ${PNG.length - 1}바이트까지 올릴 수 있습니다.`,
      ),
    );
  });

  it('기본 한도 메시지는 MB 로 읽힌다', () => {
    expect(() =>
      assertUpload(file(Buffer.alloc(MAX_UPLOAD_BYTES + 1)), ['PNG']),
    ).toThrow(new BadRequestException('파일은 10MB까지 올릴 수 있습니다.'));
  });

  it('KB 단위로 나눠 떨어지면 KB 로 읽힌다', () => {
    expect(() =>
      assertUpload({ buffer: PNG, size: 2049 }, ['PNG'], 2048),
    ).toThrow('파일은 2KB까지 올릴 수 있습니다.');
  });

  it('좁은 허용 목록은 좁은 유니온으로 돌려준다', () => {
    const kind: 'JPG' | 'PNG' = assertUpload(file(PNG), [
      'JPG',
      'PNG',
    ] as const);
    expect(kind).toBe('PNG');
  });
});

@Controller('upload-check-test')
class TestController {
  @Post()
  @UseInterceptors(AttachmentsInterceptor('files', 2, 10))
  upload(@UploadedFiles() files: { originalname: string }[]) {
    return { count: files.length, names: files.map((f) => f.originalname) };
  }

  @Post('other')
  @UseInterceptors(AttachmentsInterceptor('files', 1, 10))
  other() {
    return {};
  }
}

describe('AttachmentsInterceptor', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TestController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(() => app.close());

  it('한도 안이면 받는다', async () => {
    await request(app.getHttpServer())
      .post('/upload-check-test')
      .attach('files', Buffer.alloc(10), 'a.png')
      .expect(201, { count: 1, names: ['a.png'] });
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
    expect((res.body as { message: string }).message).toBe(
      '파일은 2개까지 올릴 수 있습니다.',
    );
  });

  it('다른 필드 이름은 Nest 의 400 을 그대로 둔다', async () => {
    const res = await request(app.getHttpServer())
      .post('/upload-check-test')
      .attach('other', Buffer.alloc(1), 'a.png');
    expect(res.status).toBe(400);
    expect((res.body as { message: string }).message).toBe(
      'Unexpected field - other',
    );
  });

  it('한글 파일 이름을 UTF-8 로 읽는다', async () => {
    await request(app.getHttpServer())
      .post('/upload-check-test')
      .attach('files', Buffer.alloc(1), '계약서.pdf')
      .expect(201, { count: 1, names: ['계약서.pdf'] });
  });

  it('텍스트 필드가 50개를 넘으면 400', async () => {
    const req = request(app.getHttpServer()).post('/upload-check-test');
    for (let i = 0; i < 51; i++) req.field(`f${i}`, 'x');
    const res = await req;
    expect(res.status).toBe(400);
    expect((res.body as { message: string }).message).toBe(
      '텍스트 항목은 50개까지 보낼 수 있습니다.',
    );
  });

  it('텍스트 필드 하나가 100KB 를 넘으면 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/upload-check-test')
      .field('memo', 'x'.repeat(100 * 1024 + 1));
    expect(res.status).toBe(400);
    expect((res.body as { message: string }).message).toBe(
      '텍스트 항목 하나는 100KB까지 보낼 수 있습니다.',
    );
  });

  it('파일 한도 개수와 텍스트 필드 50개를 함께 보내도 받는다 — 파트 수 경계', async () => {
    const req = request(app.getHttpServer()).post('/upload-check-test');
    for (let i = 0; i < 50; i++) req.field(`f${i}`, 'x');
    req
      .attach('files', Buffer.alloc(1), 'a.png')
      .attach('files', Buffer.alloc(1), 'b.png');
    const res = await req;
    expect(res.status).toBe(201);
  });

  it('텍스트 필드 몇 개와 파일은 그대로 받는다', async () => {
    await request(app.getHttpServer())
      .post('/upload-check-test')
      .field('title', '제목')
      .field('body', 'x'.repeat(100 * 1024))
      .attach('files', Buffer.alloc(1), 'a.png')
      .expect(201, { count: 1, names: ['a.png'] });
  });
});
