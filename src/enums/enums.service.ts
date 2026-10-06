import { createHash } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { EnumCatalogResponseDto, EnumValueDto } from './dto/enum.response.dto';

/** enum 이름 → [값, 한글] 목록. 순서가 곧 화면 선택지 순서다. */
export type EnumSource = Record<
  string,
  ReadonlyArray<readonly [string, string]>
>;

/**
 * front·staff 가 조회하는 enum 목록 (`GET /enums`).
 *
 * 출처는 둘이다 — DB enum(물리 ERD 원본 _model.py 에서 생성)과 DB 에 없는 API 전용 enum.
 * 목록과 version 은 만들 때 한 번 계산한다. 내용은 배포 사이에 바뀌지 않는다.
 */
export class EnumsService {
  private readonly catalog: EnumCatalogResponseDto;

  constructor(db: EnumSource, api: EnumSource) {
    const clash = Object.keys(api).filter((name) => name in db);
    if (clash.length) {
      // 같은 이름이 두 곳에 있으면 어느 한글이 나갈지 정해지지 않는다.
      throw new Error(
        `enum 이름이 DB 와 API 전용 양쪽에 있다: ${clash.join(', ')}`,
      );
    }
    const enums: Record<string, EnumValueDto[]> = {};
    for (const [name, values] of Object.entries({ ...db, ...api }).sort(
      ([a], [b]) => a.localeCompare(b),
    )) {
      enums[name] = values.map(([value, label], i) => ({
        value,
        label,
        order: i + 1,
      }));
    }
    // 내용 해시. 배포를 새로 해도 내용이 같으면 클라이언트가 캐시를 버리지 않는다.
    const version = createHash('sha256')
      .update(JSON.stringify(enums))
      .digest('hex')
      .slice(0, 16);
    this.catalog = { version, enums };
  }

  all(): EnumCatalogResponseDto {
    return this.catalog;
  }

  one(name: string): EnumCatalogResponseDto {
    const values = Object.hasOwn(this.catalog.enums, name)
      ? this.catalog.enums[name]
      : undefined;
    if (!values) throw new NotFoundException(`enum ${name} 이 없습니다`);
    return { version: this.catalog.version, enums: { [name]: values } };
  }
}
