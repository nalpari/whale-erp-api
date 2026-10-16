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
import {
  FileFieldsInterceptor,
  FilesInterceptor,
} from '@nestjs/platform-express';
import { detectFileType, type FileKind } from './file-signature';

/** 첨부파일 한 개의 기본 상한. 정책 표의 「10MB 이하」. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** 파일이 아닌 텍스트 필드 개수 상한. 한도가 없으면 필드가 메모리에 쌓인다. */
export const MAX_FIELDS = 50;
/** 텍스트 필드 하나의 크기 상한(바이트). 한글 약 3만 자. */
export const MAX_FIELD_BYTES = 100 * 1024;

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
    limits: {
      fileSize: maxBytes + 1,
      files: maxCount,
      fields: MAX_FIELDS,
      fieldSize: MAX_FIELD_BYTES + 1, // fileSize 와 같다 — 한도와 같아지면 넘친 것으로 본다
      parts: maxCount + MAX_FIELDS + 1, // 파트 수도 한도와 같아지면 넘친 것으로 본다
    },
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
        // 개수 초과를 multer 는 LIMIT_FILE_COUNT(Too many files) 또는 LIMIT_UNEXPECTED_FILE(Unexpected field - <필드>)로 낸다.
        if (
          error instanceof BadRequestException &&
          (error.message === `Unexpected field - ${field}` ||
            error.message === 'Too many files')
        )
          throw new BadRequestException(
            `파일은 ${maxCount}개까지 올릴 수 있습니다.`,
          );
        // 텍스트 필드 한도. Nest 는 multer 가 필드 이름을 붙이면 「<문구> - <필드>」로 낸다.
        if (error instanceof BadRequestException) {
          if (/^Too many (fields|parts)$/.test(error.message))
            throw new BadRequestException(
              `텍스트 항목은 ${MAX_FIELDS}개까지 보낼 수 있습니다.`,
            );
          if (error.message.startsWith('Field value too long'))
            throw new BadRequestException(
              `텍스트 항목 하나는 ${formatBytes(MAX_FIELD_BYTES)}까지 보낼 수 있습니다.`,
            );
        }
        throw error;
      }
    }
  }
  return mixin(Interceptor);
}

/**
 * 이름이 다른 파일 칸 여럿을 받는다(예: 종이 계약의 근로계약서 · 임금계약서). 칸마다 개수 한도를 두고, 크기 · 텍스트
 * 항목 한도와 한글 400 문구는 AttachmentsInterceptor 와 같다. 파일은 `@UploadedFiles()` 에 `{ 칸 이름: 파일[] }` 로
 * 온다(보내지 않은 칸은 없다). 모르는 칸 이름은 Nest 의 400(Unexpected field)을 그대로 둔다.
 */
export function AttachmentFieldsInterceptor(
  fields: readonly { name: string; maxCount: number }[],
  maxBytes = MAX_UPLOAD_BYTES,
): Type<NestInterceptor> {
  const total = fields.reduce((n, f) => n + f.maxCount, 0);
  const Base = FileFieldsInterceptor(
    fields.map((f) => ({ name: f.name, maxCount: f.maxCount })),
    {
      limits: {
        fileSize: maxBytes + 1,
        files: total,
        fields: MAX_FIELDS,
        fieldSize: MAX_FIELD_BYTES + 1,
        parts: total + MAX_FIELDS + 1,
      },
      defParamCharset: 'utf8',
    },
  );

  @Injectable()
  class Interceptor extends Base {
    async intercept(context: ExecutionContext, next: CallHandler) {
      try {
        return await super.intercept(context, next);
      } catch (error) {
        if (error instanceof PayloadTooLargeException) throw tooLarge(maxBytes);
        if (error instanceof BadRequestException) {
          // 아는 칸에서 개수를 넘으면 multer 는 그 칸 이름으로 Unexpected field 를 낸다.
          const over = fields.find(
            (f) => error.message === `Unexpected field - ${f.name}`,
          );
          if (over)
            throw new BadRequestException(
              `파일은 ${over.maxCount}개까지 올릴 수 있습니다.`,
            );
          if (error.message === 'Too many files')
            throw new BadRequestException(
              `파일은 ${total}개까지 올릴 수 있습니다.`,
            );
          if (/^Too many (fields|parts)$/.test(error.message))
            throw new BadRequestException(
              `텍스트 항목은 ${MAX_FIELDS}개까지 보낼 수 있습니다.`,
            );
          if (error.message.startsWith('Field value too long'))
            throw new BadRequestException(
              `텍스트 항목 하나는 ${formatBytes(MAX_FIELD_BYTES)}까지 보낼 수 있습니다.`,
            );
        }
        throw error;
      }
    }
  }
  return mixin(Interceptor);
}
