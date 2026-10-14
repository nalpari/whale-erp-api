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
import { assertUpload, AttachmentsInterceptor } from './upload-check';

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
