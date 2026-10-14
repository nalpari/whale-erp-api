export type StorageConfig = {
  /** 1차와 같이 쓰는 버킷. 예) whale-erp-files */
  bucket: string;
  /** 예) ap-northeast-2 */
  region: string;
};

const KEYS = {
  bucket: 'AWS_S3_BUCKET',
  region: 'AWS_S3_REGION',
} as const;

/**
 * 저장소 설정을 읽는다. 둘 다 비면 null — 서버는 뜨고 첨부 기능만 503 이다. 하나만 있으면 던진다: 반쯤 넣은
 * 설정은 실수다. 액세스 키는 읽지 않는다 — AWS SDK 가 AWS_ACCESS_KEY_ID · AWS_SECRET_ACCESS_KEY 를 직접 읽고,
 * IAM 역할을 붙인 서버에서는 비어 있다.
 */
export function readOptionalStorageConfig(
  get: (key: string) => string | undefined,
): StorageConfig | null {
  const bucket = get(KEYS.bucket)?.trim();
  const region = get(KEYS.region)?.trim();
  if (!bucket && !region) return null;
  if (!bucket || !region) {
    const empty = bucket ? KEYS.region : KEYS.bucket;
    throw new Error(`${empty} 가 비어 있습니다. .env.<APP_ENV> 를 확인하세요.`);
  }
  return { bucket, region };
}
