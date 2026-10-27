import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ListBpCodeGroupsDto } from './list-bp-code-groups.dto';

// 문서 설명만 다시 쓴 속성이라, 부모(ListCodeGroupsDto)의 변환 · 검증이 그대로 살아 있어야 한다.
describe('ListBpCodeGroupsDto manageOwnerCodes', () => {
  const parse = (manageOwnerCodes: unknown) => {
    const dto = plainToInstance(ListBpCodeGroupsDto, { manageOwnerCodes });
    return {
      dto,
      errors: validateSync(dto).map((e) => e.property),
    };
  };

  it('쉼표 · 반복을 한 배열로 받는다', () => {
    const { dto, errors } = parse(['PLATFORM_PROVIDED,PLATFORM_FIXED']);
    expect(errors).toEqual([]);
    expect(dto.manageOwnerCodes).toEqual([
      'PLATFORM_PROVIDED',
      'PLATFORM_FIXED',
    ]);
  });

  it('모르는 값은 400', () => {
    expect(parse('BP_ONLY').errors).toEqual(['manageOwnerCodes']);
  });

  it('주지 않으면 undefined', () => {
    expect(plainToInstance(ListBpCodeGroupsDto, {}).manageOwnerCodes).toBe(
      undefined,
    );
  });
});
