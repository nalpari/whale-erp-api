import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  BpAdminUpdateImpactQueryDto,
  ListBpAdminsDto,
} from './list-bp-admins.dto';

describe('ListBpAdminsDto roleTypeCodes', () => {
  const parse = (roleTypeCodes: unknown) => {
    const dto = plainToInstance(ListBpAdminsDto, {
      page: '1',
      pageSize: '20',
      roleTypeCodes,
    });
    return { dto, errors: validateSync(dto) };
  };

  it('쉼표 목록과 반복은 역할 배열로 받는다', () => {
    expect(parse('FM,FA').dto.roleTypeCodes).toEqual(['FM', 'FA']);
    expect(parse(['BA', 'FA']).dto.roleTypeCodes).toEqual(['BA', 'FA']);
    expect(parse('FM,FA').errors).toEqual([]);
  });

  it('빈 값은 조건 없음 — 400 이 아니다', () => {
    const { dto, errors } = parse('');
    expect(errors).toEqual([]);
    expect(dto.roleTypeCodes).toEqual([]);
  });

  it('BP 관리자 목록의 세 역할이 아니면 400', () => {
    expect(parse('BM').errors).not.toEqual([]);
    expect(parse('FM,XX').errors).not.toEqual([]);
  });
});

// 확인창의 수는 「저장하려는 점포」로 센다. 점포를 모두 뺀 저장은 ?storeIds= 로 오는데, 빈 값이 [''] 로 남으면
// IsInt 에 걸려 400 이 난다 — 주석대로 「비우면 모두 빼는 것」이어야 한다(PR #160 리뷰).
describe('BpAdminUpdateImpactQueryDto storeIds', () => {
  const parse = (storeIds: unknown) => {
    const dto = plainToInstance(BpAdminUpdateImpactQueryDto, {
      accountStatus: 'ACTIVE',
      storeIds,
    });
    return { dto, errors: validateSync(dto) };
  };

  it('빈 값(?storeIds=)은 점포 없음 — 400 이 아니다', () => {
    const { dto, errors } = parse('');
    expect(errors).toEqual([]);
    expect(dto.storeIds).toEqual([]);
  });

  it('쉼표 목록과 반복은 숫자 배열로 받는다', () => {
    expect(parse('5,6').dto.storeIds).toEqual([5, 6]);
    expect(parse(['5', '6']).dto.storeIds).toEqual([5, 6]);
  });

  it('숫자가 아닌 값은 400', () => {
    expect(parse('5,x').errors).not.toEqual([]);
  });
});
