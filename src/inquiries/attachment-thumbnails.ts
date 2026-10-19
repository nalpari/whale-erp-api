import type { Logger } from '@nestjs/common';
import type { OptionalStorage } from '../storage/storage.module';

/**
 * 문의 첨부 행에 작은 미리보기 주소(`thumbnailUrl`, 300초)를 싣고 저장 키는 뺀다 — 관리자 문의 상세(#277)와 내 문의
 * 상세(#284)가 같이 쓴다. PDF 는 저장소가 null 을 준다. 저장소 설정이 없거나 서명이 실패하면 null 로 두어 상세는 그대로
 * 보인다. 서명 실패는 몇 건인지와 첫 원인을 warn 한 줄로 남긴다(자격 증명이 깨지면 모두 실패한다 — 점포 목록과 같다).
 * 썸네일이 실제로 있는지는 보지 않는다(okf/api/inquiries.md).
 */
export async function withThumbnails<T extends { storageKey: string }>(
  storage: OptionalStorage,
  rows: readonly T[],
  logger: Logger,
): Promise<(Omit<T, 'storageKey'> & { thumbnailUrl: string | null })[]> {
  const failures: { storageKey: string; error: unknown }[] = [];
  const urls = await Promise.all(
    rows.map(async ({ storageKey }) => {
      if (!storage) return null;
      try {
        return await storage.thumbnailUrl(storageKey);
      } catch (error) {
        failures.push({ storageKey, error });
        return null;
      }
    }),
  );
  if (failures.length)
    logger.warn(
      // 두 번째 인자는 Nest 가 context 로 읽어 클래스 이름 자리를 덮으므로 원인은 메시지에 합친다.
      `문의 첨부 썸네일 주소를 만들지 못했다 ${failures.length}/${rows.length}건 첫 storageKey=${failures[0].storageKey} cause=${
        failures[0].error instanceof Error
          ? failures[0].error.stack
          : String(failures[0].error)
      }`,
    );
  return rows.map((row, i) => {
    const { storageKey, ...shown } = row;
    void storageKey;
    return { ...shown, thumbnailUrl: urls[i] };
  });
}
