import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { FileKind } from './file-signature';

/** 내려받기 주소의 유효 시간. 권한을 확인한 뒤 주므로 짧게 둔다. */
export const DOWNLOAD_URL_SECONDS = 300;

// 1차 ERP 가 쓰던 맨 앞 폴더. 같은 버킷을 쓰므로 겹치지 않게 막는다 — images/ 는 공개 버킷 정책이 걸려 있다.
const FIRST_GEN_ROOTS = ['images', 'attachments'];
// 확장자와 Content-Type 은 클라이언트가 보낸 값을 믿지 않고 내용으로 판정한 종류에서 만든다.
const CONTENT_TYPES: Record<FileKind, string> = {
  JPG: 'image/jpeg',
  PNG: 'image/png',
  PDF: 'application/pdf',
};
const DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
// newKey 가 만드는 모양. put · downloadUrl · delete 는 이 모양이 아니면 받지 않는다.
const KEY_PATTERN =
  /^([a-z0-9][a-z0-9-]*)\/\d+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|pdf)$/;

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
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  /** `{도메인}/{ID}/{UUID}.{확장자}`. 도메인은 첨부가 붙는 업무 이름(예: inquiries)이다. */
  static newKey(domain: string, ownerId: number, kind: FileKind): string {
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

  async put(key: string, body: Buffer, kind: FileKind): Promise<void> {
    StorageService.assertKey(key);
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: CONTENT_TYPES[kind],
      }),
    );
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

  async delete(key: string): Promise<void> {
    StorageService.assertKey(key);
    await this.s3.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}
