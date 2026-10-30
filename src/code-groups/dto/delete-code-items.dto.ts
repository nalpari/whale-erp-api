import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, Matches } from 'class-validator';
import {
  CODE_FORMAT_MESSAGE,
  CODE_PATTERN,
  MAX_ITEM_ROWS,
  toUpperCode,
} from '../code-format';

/**
 * 상세 코드 삭제 — 고른 그룹의 상세 코드 여러 개를 한 번에 논리 삭제한다. 플랫폼 공통코드 관리 · BP 공통코드 관리가
 * 함께 쓴다. 지운 코드를 같은 코드로 다시 등록하면 그 행이 되살아난다(등록의 중복 검사는 살아 있는 행만 본다) — 플랫폼
 * 화면에서는 BP 에 플랫폼제공 복사본이 살아 있어도 되살리고, 같은 코드의 BP전용 행이 살아 있으면 409 다.
 */
export class DeleteCodeItemsDto {
  /** 지울 상세 코드. 1~500건, 등록과 같이 앞뒤 공백을 지우고 대문자로 받는다. 한 요청 안에서 겹치면 409. @example ["INTERN"] */
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value)
      ? value.map((v: unknown) => toUpperCode({ value: v }))
      : value,
  )
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ITEM_ROWS)
  @Matches(CODE_PATTERN, {
    each: true,
    message: CODE_FORMAT_MESSAGE,
  })
  itemCodes: string[];
}
