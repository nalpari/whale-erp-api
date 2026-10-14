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

const formatBytes = (n: number) =>
  n % (1024 * 1024) === 0
    ? `${n / (1024 * 1024)}MB`
    : n % 1024 === 0
      ? `${n / 1024}KB`
      : `${n}바이트`;

const tooLarge = (maxBytes: number) =>
  new BadRequestException(
    `파일은 ${formatBytes(maxBytes)}까지 올릴 수 있습니다.`,
  );

/** 파일 하나를 검사한다. 종류는 내용으로 판정하고, 허용 목록에 없거나 크기를 넘으면 400. */
export function assertUpload<K extends FileKind>(
  file: { buffer: Buffer; size: number },
  allowed: readonly K[],
  maxBytes = MAX_UPLOAD_BYTES,
): K {
  if (file.size > maxBytes) throw tooLarge(maxBytes);
  const kind = detectFileType(file.buffer);
  if (!kind || !allowed.includes(kind as K))
    throw new BadRequestException(
      `${allowed.join(' · ')} 파일만 올릴 수 있습니다.`,
    );
  return kind as K;
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
  // busboy 는 크기가 한도와 같아지면 넘친 것으로 본다. +1 해야 정확히 maxBytes 인 파일을 받는다.
  const Base = FilesInterceptor(field, maxCount, {
    limits: { fileSize: maxBytes + 1 },
    // multer 는 파일 이름을 latin1 로 읽어 한글이 깨진다.
    defParamCharset: 'utf8',
  });

  @Injectable()
  class Interceptor extends Base {
    async intercept(context: ExecutionContext, next: CallHandler) {
      try {
        return await super.intercept(context, next);
      } catch (error) {
        if (error instanceof PayloadTooLargeException) throw tooLarge(maxBytes);
        // 개수 초과를 multer 는 LIMIT_UNEXPECTED_FILE(Unexpected field - <필드>)로 낸다.
        if (
          error instanceof BadRequestException &&
          error.message === `Unexpected field - ${field}`
        )
          throw new BadRequestException(
            `파일은 ${maxCount}개까지 올릴 수 있습니다.`,
          );
        throw error;
      }
    }
  }
  return mixin(Interceptor);
}
