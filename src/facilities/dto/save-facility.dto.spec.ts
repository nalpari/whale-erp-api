import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateFacilityDto, UpdateFacilityDto } from './save-facility.dto';

/** 점포를 뺀 필수 칸 — 수정 몸통 */
const withoutStore = {
  name: 'EK43S 전자동 원두 커피 그라인더',
  facilityStatusCode: 'OPERATING',
  facilityGroupCode: 'STORE_EQUIPMENT',
  facilityCategoryCode: 'GRINDER',
};
const required = { storeId: 3, ...withoutStore };

function errorsOf<T extends object>(cls: new () => T, body: object) {
  const dto = plainToInstance(cls, body);
  return {
    dto,
    messages: validateSync(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    }).flatMap((e) => Object.values(e.constraints ?? {})),
  };
}

describe('SaveFacilityDto', () => {
  it('필수 다섯 칸만으로 통과하고 기본값을 채운다 — 수량 1 · 부가세 포함', () => {
    const { dto, messages } = errorsOf(CreateFacilityDto, required);
    expect(messages).toEqual([]);
    expect(dto.quantity).toBe(1);
    expect(dto.isVatIncluded).toBe(true);
  });

  it('이름은 앞뒤 공백을 지우고, 비면 400', () => {
    const { messages } = errorsOf(CreateFacilityDto, {
      ...required,
      name: '   ',
    });
    expect(messages.length).toBeGreaterThan(0);
  });

  it('이름은 100자까지', () => {
    expect(
      errorsOf(CreateFacilityDto, { ...required, name: 'a'.repeat(100) })
        .messages,
    ).toEqual([]);
    expect(
      errorsOf(CreateFacilityDto, { ...required, name: 'a'.repeat(101) })
        .messages.length,
    ).toBeGreaterThan(0);
  });

  it('그룹은 점포 시설물 · 점포 장비 둘뿐', () => {
    const { messages } = errorsOf(CreateFacilityDto, {
      ...required,
      facilityGroupCode: 'STORE_STATUS',
    });
    expect(messages.length).toBeGreaterThan(0);
  });

  it.each([
    ['vendorPhone', '구매처 전화번호는 숫자 9~12자리입니다.'],
    ['salesRepresentativePhone', '영업사원 전화번호는 숫자 9~12자리입니다.'],
    ['managerPhone', '관리 담당자 전화번호는 숫자 9~12자리입니다.'],
    ['serviceCenterPhone', 'A/S센터 전화번호는 숫자 9~12자리입니다.'],
  ])('%s 가 9~12자리가 아니면 「%s」', (field, message) => {
    expect(
      errorsOf(CreateFacilityDto, { ...required, [field]: '0102' }).messages,
    ).toEqual([message]);
    expect(
      errorsOf(CreateFacilityDto, { ...required, [field]: '0212345678' })
        .messages,
    ).toEqual([]);
    expect(
      errorsOf(CreateFacilityDto, { ...required, [field]: '050712345678' })
        .messages,
    ).toEqual([]);
  });

  it('전화번호의 하이픈 · 공백은 떼고 본다', () => {
    const { dto, messages } = errorsOf(CreateFacilityDto, {
      ...required,
      vendorPhone: '02-1234-5678',
    });
    expect(messages).toEqual([]);
    expect(dto.vendorPhone).toBe('0212345678');
  });

  it('빈 선택 칸은 null 로 — 지우는 것과 같다', () => {
    const { dto, messages } = errorsOf(CreateFacilityDto, {
      ...required,
      brand: '',
      vendorPhone: '',
      purchaseDate: '',
    });
    expect(messages).toEqual([]);
    expect(dto.brand).toBeNull();
    expect(dto.vendorPhone).toBeNull();
    expect(dto.purchaseDate).toBeNull();
  });

  it('단가는 0 이상 10자리 정수, 수량은 1~9,999', () => {
    expect(
      errorsOf(CreateFacilityDto, {
        ...required,
        unitPriceAmount: 9_999_999_999,
        quantity: 9_999,
      }).messages,
    ).toEqual([]);
    expect(
      errorsOf(CreateFacilityDto, {
        ...required,
        unitPriceAmount: 10_000_000_000,
      }).messages.length,
    ).toBeGreaterThan(0);
    expect(
      errorsOf(CreateFacilityDto, { ...required, unitPriceAmount: -1 }).messages
        .length,
    ).toBeGreaterThan(0);
    expect(
      errorsOf(CreateFacilityDto, { ...required, unitPriceAmount: 1.5 })
        .messages.length,
    ).toBeGreaterThan(0);
    expect(
      errorsOf(CreateFacilityDto, { ...required, quantity: 0 }).messages.length,
    ).toBeGreaterThan(0);
    expect(
      errorsOf(CreateFacilityDto, { ...required, quantity: 10_000 }).messages
        .length,
    ).toBeGreaterThan(0);
  });

  it('메모는 공백 · 줄바꿈을 포함해 200자까지, 앞뒤 공백도 그대로 둔다', () => {
    const memo = ` 첫 줄\n${'가'.repeat(194)} `;
    expect(memo.length).toBe(200);
    const { dto, messages } = errorsOf(CreateFacilityDto, {
      ...required,
      memo,
    });
    expect(messages).toEqual([]);
    expect(dto.memo).toBe(memo);
    expect(
      errorsOf(CreateFacilityDto, { ...required, memo: `${memo}가` }).messages
        .length,
    ).toBeGreaterThan(0);
  });

  it('날짜는 YYYY-MM-DD 이고 실제 있는 날', () => {
    expect(
      errorsOf(CreateFacilityDto, { ...required, purchaseDate: '2025-02-30' })
        .messages,
    ).toEqual(['구매일은 YYYY-MM-DD 입니다.']);
  });

  it('등록에는 점포가 있어야 한다', () => {
    expect(
      errorsOf(CreateFacilityDto, withoutStore).messages.length,
    ).toBeGreaterThan(0);
  });

  it('수정은 점포를 받지 않는다 — 등록 뒤 바꿀 수 없다(PL-1)', () => {
    const { messages } = errorsOf(UpdateFacilityDto, {
      ...required,
      updatedAt: '2026-11-11T01:02:03.004Z',
    });
    expect(messages).toEqual(['property storeId should not exist']);
  });

  it('수정은 상세의 updatedAt 을 함께 보낸다', () => {
    expect(
      errorsOf(UpdateFacilityDto, withoutStore).messages.length,
    ).toBeGreaterThan(0);
    expect(
      errorsOf(UpdateFacilityDto, {
        ...withoutStore,
        updatedAt: '2026-11-11T01:02:03.004Z',
      }).messages,
    ).toEqual([]);
  });
});
