import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { FileKind } from './file-signature';
import { makeThumbnail } from './thumbnail';

/** 내려받기 주소의 유효 시간. 권한을 확인한 뒤 주므로 짧게 둔다. */
export const DOWNLOAD_URL_SECONDS = 300;
/**
 * 올리기 한 번(SDK 재시도 포함)의 전체 기한. 응답이 멈춘 요청이 끝없이 매달리지 않게 끊는다 — SDK 의 requestTimeout 은
 * 경고만 남기고 끊지 않는다(@smithy/node-http-handler 4.12). 10MB 를 올리기에 넉넉하고, 근로계약 날인본 둘이
 * 쓰기 트랜잭션(60초) 안에 끝나는 값이다.
 */
export const PUT_DEADLINE_MS = 25_000;
/** zip(직원 자료 일괄 저장, 최대 200MB) 올리기의 기한 — 일반 첨부보다 크다. 배치 안이라 쓰기 트랜잭션에 묶이지 않는다 */
export const ZIP_PUT_DEADLINE_MS = 10 * 60_000;

/**
 * 저장소에 두는 파일 종류. 올린 파일의 종류(FileKind, 내용으로 판정)에 서버가 만든 엑셀(XLSX) · 직원 자료 일괄 저장 zip(ZIP)을
 * 더한 것이다 — 둘 다 업로드 검사의 종류가 아니어서 사용자가 첨부로 올릴 수는 없다.
 */
export type StoredFileKind = FileKind | 'XLSX' | 'ZIP';

// 1차 ERP 가 쓰던 맨 앞 폴더. 같은 버킷을 쓰므로 겹치지 않게 막는다 — images/ 는 공개 버킷 정책이 걸려 있다.
const FIRST_GEN_ROOTS = ['images', 'attachments'];
// 확장자와 Content-Type 은 클라이언트가 보낸 값을 믿지 않고 내용으로 판정한 종류에서 만든다.
const CONTENT_TYPES: Record<StoredFileKind, string> = {
  JPG: 'image/jpeg',
  PNG: 'image/png',
  PDF: 'application/pdf',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ZIP: 'application/zip',
};
const DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
// newKey 가 만드는 원본 키와, 거기서 이끌어 낸 썸네일 키(.thumb.jpg). put · downloadUrl · delete 는 이 모양만 받는다.
const KEY_PATTERN =
  /^([a-z0-9][a-z0-9-]*)\/\d+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.(?:jpg|png|pdf|xlsx|zip)|\.thumb\.jpg)$/;
const IMAGE_KEY = /\.(?:jpg|png)$/;
const THUMB_SUFFIX = '.thumb.jpg';

/** put 의 썸네일 옵션. true 면 기본 크기, { maxPx } 면 그 긴 변(px). */
export type ThumbnailOption = boolean | { maxPx: number };

/** 원래 파일 이름으로 내려받게 하는 헤더 값. RFC 5987 — encodeURIComponent 가 남기는 ' ( ) * 까지 인코딩한다. */
export function contentDisposition(fileName: string): string {
  // 짝 없는 서로게이트는 encodeURIComponent 가 던진다. toWellFormed 는 ES2024 라 정규식으로 바꾼다.
  const wellFormed = fileName.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '\uFFFD',
  );
  const encoded = encodeURIComponent(wellFormed).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename*=UTF-8''${encoded}`;
}

/**
 * 첨부파일 저장소(S3). 업무 모듈이 multipart 를 받아 검사한 뒤 이 서비스로 올리고, DB 에는 키만 남긴다.
 * S3 오류는 Error 그대로 올린다 — 호출부가 처리한다.
 */
export class StorageService {
  private static readonly logger = new Logger(StorageService.name);

  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  /** `{도메인}/{ID}/{UUID}.{확장자}`. 도메인은 첨부가 붙는 업무 이름(예: inquiries)이다. */
  static newKey(domain: string, ownerId: number, kind: StoredFileKind): string {
    if (!DOMAIN_PATTERN.test(domain) || FIRST_GEN_ROOTS.includes(domain))
      throw new Error(`저장소 키에 쓸 수 없는 도메인 이름입니다: ${domain}`);
    if (!Number.isSafeInteger(ownerId) || ownerId < 0)
      throw new Error(`저장소 키에 쓸 수 없는 소유자 ID 입니다: ${ownerId}`);
    return `${domain}/${ownerId}/${randomUUID()}.${kind.toLowerCase()}`;
  }

  /** 1차 폴더를 건드리거나 newKey 모양이 아닌 키는 S3 를 부르기 전에 막는다. */
  private static assertKey(key: string): void {
    const root = KEY_PATTERN.exec(key)?.[1];
    if (!root || FIRST_GEN_ROOTS.includes(root))
      throw new Error(`저장소 키 형식이 아닙니다: ${key}`);
  }

  /** 원본 이미지 키 → 썸네일 키. PDF · 썸네일 키 · 형식 밖은 던진다. */
  static thumbnailKey(key: string): string {
    StorageService.assertKey(key);
    if (key.endsWith(THUMB_SUFFIX) || !IMAGE_KEY.test(key))
      throw new Error(`썸네일이 없는 키입니다: ${key}`);
    return key.replace(IMAGE_KEY, THUMB_SUFFIX);
  }

  /**
   * 원본을 올린다. thumbnail 이 켜져 있고 JPG · PNG 면 줄인 사본(.thumb.jpg)도 올린다 — PDF · XLSX 는 건너뛴다.
   * thumbnail: true 면 기본 크기, { maxPx } 면 업무가 정한 긴 변(px).
   * 사본을 먼저 만들어 깨진 이미지면 아무것도 올리지 않고, 사본 올리기가 실패하면 사본 → 원본 순으로 지운다.
   */
  async put(
    key: string,
    body: Buffer,
    kind: StoredFileKind,
    options: { thumbnail?: ThumbnailOption } = {},
  ): Promise<void> {
    StorageService.assertKey(key);
    if (key.endsWith(THUMB_SUFFIX))
      throw new Error(`썸네일 키에는 원본을 올릴 수 없습니다: ${key}`);
    if (!key.endsWith(`.${kind.toLowerCase()}`))
      throw new Error(`키 확장자와 파일 종류가 다릅니다: ${key} (${kind})`);
    const { thumbnail: option } = options;
    const thumbnail =
      option && (kind === 'JPG' || kind === 'PNG')
        ? await makeThumbnail(body, option === true ? undefined : option.maxPx)
        : null;
    const thumbKey = thumbnail ? StorageService.thumbnailKey(key) : null;
    await this.putObject(
      key,
      body,
      CONTENT_TYPES[kind],
      kind === 'ZIP' ? ZIP_PUT_DEADLINE_MS : PUT_DEADLINE_MS,
    );
    if (!thumbnail || !thumbKey) return;
    try {
      await this.putObject(thumbKey, thumbnail, 'image/jpeg');
    } catch (error) {
      // 원래 오류를 올리려고 정리 실패는 삼키되 남았을 수 있는 키와 원인을 경고로 남긴다. 썸네일 먼저 — 사본만 남지 않게.
      for (const stale of [thumbKey, key])
        await this.deleteObject(stale).catch((cause: unknown) =>
          StorageService.logger.warn(
            `썸네일 업로드 실패 뒤 정리하지 못한 키: ${stale} (${
              cause instanceof Error
                ? `${cause.name}: ${cause.message}`
                : String(cause)
            })`,
          ),
        );
      throw error;
    }
  }

  /** 권한을 확인한 뒤 부른다. 주소를 가진 사람은 유효 시간 동안 누구나 받을 수 있다. */
  async downloadUrl(key: string, fileName: string): Promise<string> {
    StorageService.assertKey(key);
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: contentDisposition(fileName),
      }),
      { expiresIn: DOWNLOAD_URL_SECONDS },
    );
  }

  /** 키의 내용을 읽는다. 서버가 저장한 파일을 다시 묶을 때(직원 자료 일괄 저장) 쓴다. 권한을 확인한 뒤 부른다. */
  async get(key: string): Promise<Buffer> {
    StorageService.assertKey(key);
    const { Body } = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      // SDK requestTimeout 은 끊지 않는다 — 기한이 없으면 응답 없는 S3 에 배치가 통째로 묶인다
      { abortSignal: AbortSignal.timeout(PUT_DEADLINE_MS) },
    );
    if (!Body) throw new Error(`저장소 파일에 내용이 없습니다: ${key}`);
    // 받은 바이트를 복사하지 않고 감싼다 — 일괄 저장이 파일을 모두 메모리에 쥐므로 사본이 두 배로 든다
    const bytes = await Body.transformToByteArray();
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** 원본 키를 받아 썸네일의 300초 주소를 준다. PDF 는 null. 목록 · 상세의 작은 미리보기용. 권한을 확인한 뒤 부른다. */
  async thumbnailUrl(key: string): Promise<string | null> {
    StorageService.assertKey(key);
    if (key.endsWith('.pdf')) return null;
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: StorageService.thumbnailKey(key),
      }),
      { expiresIn: DOWNLOAD_URL_SECONDS },
    );
  }

  /** 이미지면 썸네일을 먼저 지운다 — 중간에 실패해도 사본만 남지 않게. 없는 썸네일 삭제는 S3 가 성공으로 본다. */
  /**
   * 원본을 지운다. JPG · PNG 원본이면 썸네일을 먼저 지운다 — 썸네일 없이 올린 파일(예: 근로계약 날인본)은
   * `{ thumbnail: false }` 로 원본만 지운다(없는 썸네일을 지우느라 기다리지 않게).
   */
  async delete(
    key: string,
    options: { thumbnail?: boolean } = {},
  ): Promise<void> {
    StorageService.assertKey(key);
    if (
      options.thumbnail !== false &&
      IMAGE_KEY.test(key) &&
      !key.endsWith(THUMB_SUFFIX)
    )
      await this.deleteObject(StorageService.thumbnailKey(key));
    await this.deleteObject(key);
  }

  private async putObject(
    key: string,
    body: Buffer,
    contentType: string,
    deadlineMs = PUT_DEADLINE_MS,
  ) {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
      { abortSignal: AbortSignal.timeout(deadlineMs) },
    );
  }

  private async deleteObject(key: string) {
    // 올리기가 기한에 걸린 바로 그때(S3 무응답) 정리도 매달리지 않게 같은 기한을 건다
    await this.s3.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      { abortSignal: AbortSignal.timeout(PUT_DEADLINE_MS) },
    );
  }
}
