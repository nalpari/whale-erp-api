import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { ListCodeGroupsDto } from '../../code-groups/dto/list-code-groups.dto';
import {
  PLATFORM_PROVIDED_OWNER_CODE,
  type PlatformOwnerCode,
} from '../../code-groups/code-format';

/**
 * BP 공통코드 그룹 목록 검색 — 플랫폼 공통코드 관리와 같은 조건(쪽 · 그룹 코드 · 그룹명 · 관리 주체). 대상 BP 는 쿼리가 아니라
 * X-Bp-Code-Id 헤더로 받는다(가드가 정한다).
 */
export class ListBpCodeGroupsDto extends ListCodeGroupsDto {
  // 반복 · 쉼표 변환과 부모의 검증은 그대로 물려받고, 보이는 관리 주체(플랫폼제공)만 받도록 검증을 하나 더 건다.
  // 초기값 `= undefined` 는 부모 속성을 다시 선언하려고 둔다 — 없으면 TS2612(기반 속성을 덮어씀)이고, `declare` 는
  // 데코레이터를 달 수 없어 쓰지 못한다. 값은 부모와 같다(주지 않으면 undefined).
  @ApiPropertyOptional({
    description:
      '관리 주체. BP 공통코드 관리에는 플랫폼제공 그룹만 보이므로 `PLATFORM_PROVIDED` 만 받는다(다른 값은 400). 주지 않으면 플랫폼제공 전체.',
    type: [String],
    enum: [PLATFORM_PROVIDED_OWNER_CODE],
  })
  @IsIn([PLATFORM_PROVIDED_OWNER_CODE], { each: true })
  manageOwnerCodes?: PlatformOwnerCode[] = undefined;
}
