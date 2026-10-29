import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, Matches } from 'class-validator';
import { CODE_PATTERN, MAX_ITEM_ROWS, toUpperCode } from '../code-format';

/**
 * 상세 코드 삭제 — 고른 그룹의 상세 코드 여러 개를 한 번에 논리 삭제한다. 플랫폼 공통코드 관리 · BP 공통코드 관리가
 * 함께 쓴다. 지운 코드를 같은 코드로 다시 등록하면 그 행이 되살아난다(등록의 중복 검사는 살아 있는 행만 본다) — 단
 * 플랫폼 화면에서는 어느 BP 에 복사본이 살아 있으면 409 다.
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
    message:
      '상세 코드는 영문 대문자·숫자·밑줄만 쓰고 영문으로 시작하며 20자 이내입니다.',
  })
  itemCodes: string[];
}
