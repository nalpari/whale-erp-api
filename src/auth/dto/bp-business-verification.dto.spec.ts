import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { BpBusinessVerificationDto } from './bp-business-verification.dto';

const check = (bizOpenDate: string) => {
  const dto = plainToInstance(BpBusinessVerificationDto, {
    bizRegistrationNumber: '1234567890',
    bizCeoName: '남도현',
    bizOpenDate,
  });
  return validateSync(dto).find((e) => e.property === 'bizOpenDate');
};

describe('BpBusinessVerificationDto 개업일자', () => {
  it('실제로 있는 YYYY-MM-DD 만 받는다', () => {
    expect(check('2021-03-15')).toBeUndefined();
    expect(check('2024-02-29')).toBeUndefined();
  });

  it.each(['abc', '2021-3-15', '2021-02-30', '2023-02-29', '', '20210315'])(
    '모양이 틀리거나 없는 날짜는 문구 하나로 거절한다(기본 형식 YYYYMMDD · 확장 형식 모두 포함 — 코드 리뷰로 찾음): %p',
    (value) => {
      const failed = check(value);
      expect(failed).toBeDefined();
      expect(Object.values(failed?.constraints ?? {})).toEqual([
        '개업일자는 YYYY-MM-DD 로 입력해 주세요.',
      ]);
    },
  );
});

describe('BpBusinessVerificationDto 사업자등록번호', () => {
  it('하이픈을 넣어 보내도 숫자만 남겨 받는다(점포 등록과 같다 — 코드 리뷰로 찾음)', () => {
    const dto = plainToInstance(BpBusinessVerificationDto, {
      bizRegistrationNumber: '105-87-63602',
      bizCeoName: '남도현',
      bizOpenDate: '2021-03-15',
    });
    expect(dto.bizRegistrationNumber).toBe('1058763602');
    expect(
      validateSync(dto).find((e) => e.property === 'bizRegistrationNumber'),
    ).toBeUndefined();
  });
});
