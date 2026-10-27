import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ListBpCodeGroupsDto } from './list-bp-code-groups.dto';

// BP 화면에는 플랫폼제공 그룹만 보이므로 관리 주체도 PLATFORM_PROVIDED 만 받는다. 반복 · 쉼표 변환은 부모 그대로다.
describe('ListBpCodeGroupsDto manageOwnerCodes', () => {
  const parse = (manageOwnerCodes: unknown) => {
    const dto = plainToInstance(ListBpCodeGroupsDto, { manageOwnerCodes });
    return {
      dto,
      errors: validateSync(dto).map((e) => e.property),
    };
  };

  it('쉼표 · 빈 조각을 부모처럼 한 배열로 받는다', () => {
    const { dto, errors } = parse(['PLATFORM_PROVIDED,']);
    expect(errors).toEqual([]);
    expect(dto.manageOwnerCodes).toEqual(['PLATFORM_PROVIDED']);
  });

  it.each([
    ['PLATFORM_FIXED'],
    ['PLATFORM_PROVIDED,PLATFORM_FIXED'],
    ['BP_ONLY'],
  ])('%p 는 400 — 보이지 않는 관리 주체', (value) => {
    expect(parse(value).errors).toEqual(['manageOwnerCodes']);
  });

  it('주지 않으면 undefined', () => {
    expect(plainToInstance(ListBpCodeGroupsDto, {}).manageOwnerCodes).toBe(
      undefined,
    );
  });
});
