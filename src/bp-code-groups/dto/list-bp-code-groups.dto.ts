import { ApiPropertyOptional } from '@nestjs/swagger';
import { ListCodeGroupsDto } from '../../code-groups/dto/list-code-groups.dto';
import type { PlatformOwnerCode } from '../../code-groups/code-format';

/**
 * BP 공통코드 그룹 목록 검색 — 플랫폼 공통코드 관리와 같은 조건(쪽 · 그룹 코드 · 그룹명 · 관리 주체). 대상 BP 는 쿼리가 아니라
 * X-Bp-Code-Id 헤더로 받는다(가드가 정한다).
 */
export class ListBpCodeGroupsDto extends ListCodeGroupsDto {
  // 검증 · 변환은 부모의 데코레이터를 그대로 물려받는다. 문서 설명만 BP 화면에 맞게 다시 쓴다(= undefined 는 TS 가
  // 부모 속성을 다시 선언하는 것을 허락받는 표시일 뿐, 값은 부모와 같다).
  @ApiPropertyOptional({
    description:
      '관리 주체. BP 공통코드 관리에는 플랫폼제공 그룹만 보이므로 `PLATFORM_PROVIDED` 만 의미가 있다 — `PLATFORM_FIXED` 만 주면 빈 목록이다. 주지 않으면 플랫폼제공 전체.',
    type: [String],
    enum: ['PLATFORM_PROVIDED'],
  })
  manageOwnerCodes?: PlatformOwnerCode[] = undefined;
}
