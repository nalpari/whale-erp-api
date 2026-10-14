import { readOptionalStorageConfig } from './storage.config';

const config = (values: Record<string, string>) => (key: string) => values[key];

describe('readOptionalStorageConfig', () => {
  it('둘 다 비면 null — 서버는 뜨고 첨부만 503 이다', () => {
    expect(readOptionalStorageConfig(config({}))).toBeNull();
    expect(
      readOptionalStorageConfig(
        config({ AWS_S3_BUCKET: ' ', AWS_S3_REGION: '' }),
      ),
    ).toBeNull();
  });

  it('둘 다 있으면 앞뒤 공백을 떼어 돌려준다', () => {
    expect(
      readOptionalStorageConfig(
        config({
          AWS_S3_BUCKET: ' whale-erp-files ',
          AWS_S3_REGION: 'ap-northeast-2',
        }),
      ),
    ).toEqual({ bucket: 'whale-erp-files', region: 'ap-northeast-2' });
  });

  it.each([
    [{ AWS_S3_BUCKET: 'whale-erp-files' }, 'AWS_S3_REGION'],
    [{ AWS_S3_REGION: 'ap-northeast-2' }, 'AWS_S3_BUCKET'],
  ])(
    '하나만 넣으면 빈 키 이름으로 던진다 — 반쯤 넣은 설정은 실수다',
    (values, key) => {
      expect(() => readOptionalStorageConfig(config(values))).toThrow(key);
    },
  );
});
