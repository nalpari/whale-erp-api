import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SaveStoreDto, StoreBusinessInputDto } from './save-store.dto';

// 점포 연락처는 지역번호 · 휴대전화 · 050X 평생번호(12자리)를 받는다. DB CHECK(stores_phone_format)와 같은
// 범위여야 검증을 통과한 값이 DB 에서 500 으로 막히지 않는다.
describe('SaveStoreDto phone', () => {
  const phoneErrors = (phone: unknown) =>
    validateSync(plainToInstance(SaveStoreDto, { name: '점포', phone }))
      .filter((e) => e.property === 'phone')
      .flatMap((e) => Object.values(e.constraints ?? {}));

  it.each([
    ['021234567', '9자리 서울 지역번호'],
    ['0212345678', '10자리'],
    ['01012345678', '11자리 휴대전화'],
    ['050720331334', '12자리 050X 평생번호'],
  ])('%s (%s) 는 받는다', (phone) => {
    expect(phoneErrors(phone)).toEqual([]);
  });

  it.each(['02123456', '0507203313345', '0507-2033-1334'])(
    '%s 는 400 — 숫자 9~12자리만',
    (phone) => {
      expect(phoneErrors(phone)).toEqual([
        '점포 연락처는 숫자 9~12자리입니다.',
      ]);
    },
  );

  it('비우면 null 로 받는다', () => {
    expect(phoneErrors('')).toEqual([]);
  });
});

// 대표자 연락처도 점포 연락처와 같은 9~12자리다. DB CHECK(store_business_profiles_biz_ceo_phone_format)도
// 같은 범위로 넓혔다.
describe('StoreBusinessInputDto ceoPhone', () => {
  const ceoPhoneErrors = (ceoPhone: unknown) =>
    validateSync(plainToInstance(StoreBusinessInputDto, { ceoPhone }))
      .filter((e) => e.property === 'ceoPhone')
      .flatMap((e) => Object.values(e.constraints ?? {}));

  it.each(['021234567', '01012345678', '050720331334'])(
    '%s 는 받는다',
    (ceoPhone) => {
      expect(ceoPhoneErrors(ceoPhone)).toEqual([]);
    },
  );

  it.each(['02123456', '0507203313345', '010-1234-5678'])(
    '%s 는 400 — 숫자 9~12자리만',
    (ceoPhone) => {
      expect(ceoPhoneErrors(ceoPhone)).toEqual([
        '대표자 연락처는 숫자 9~12자리입니다.',
      ]);
    },
  );
});
