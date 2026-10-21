import {
  type AccountIdentity,
  type ContractIdentity,
  identityMismatches,
} from './identity-match';

const contract = (o: Partial<ContractIdentity> = {}): ContractIdentity => ({
  enteredName: '홍길동',
  enteredPhone: '01090145563',
  enteredBirthDate: new Date('1995-03-02T00:00:00.000Z'),
  enteredGender: 'FEMALE',
  isForeigner: false,
  ...o,
});
const account = (o: Partial<AccountIdentity> = {}): AccountIdentity => ({
  realName: '홍길동',
  phone: '01090145563',
  birthDate: new Date('1995-03-02T00:00:00.000Z'),
  gender: 'FEMALE',
  isForeigner: false,
  ...o,
});

// 날인 전 본인 대조(WHALEERP-125 · 145)
describe('identityMismatches', () => {
  it('다섯이 모두 같으면 빈 배열 — 날인할 수 있다', () => {
    expect(identityMismatches(contract(), account())).toEqual([]);
  });

  it('이름은 공백을 모두 지우고 영문은 대문자로 비교한다', () => {
    expect(
      identityMismatches(
        contract({ enteredName: 'John  Smith' }),
        account({ realName: 'JOHNSMITH' }),
      ),
    ).toEqual([]);
    expect(
      identityMismatches(
        contract({ enteredName: '홍 길동' }),
        account({ realName: '홍길동' }),
      ),
    ).toEqual([]);
  });

  it('휴대전화번호는 숫자만 비교한다', () => {
    expect(
      identityMismatches(
        contract({ enteredPhone: '010-9014-5563' }),
        account(),
      ),
    ).toEqual([]);
  });

  it('다른 항목을 모두 알려 준다', () => {
    expect(
      identityMismatches(
        contract({
          enteredName: '홍길순',
          enteredPhone: '01011112222',
          enteredBirthDate: new Date('1995-03-03T00:00:00.000Z'),
          enteredGender: 'MALE',
          isForeigner: true,
        }),
        account(),
      ),
    ).toEqual(['name', 'phone', 'birthDate', 'gender', 'isForeigner']);
  });

  it('계약서 칸이 비어 있으면 다른 것이다 — 관리자가 근로자 정보 수정으로 채운다', () => {
    expect(
      identityMismatches(
        contract({
          enteredName: null,
          enteredPhone: null,
          enteredBirthDate: null,
          enteredGender: null,
        }),
        account(),
      ),
    ).toEqual(['name', 'phone', 'birthDate', 'gender']);
  });

  it('계정 성별이 비어 있어도 성별을 본다 — 가입 때 필수라 다섯 가지를 그대로 대조한다(ACC-23 · JOI-10, 2026-10-21 재영)', () => {
    expect(
      identityMismatches(
        contract({ enteredGender: 'MALE' }),
        account({ gender: null }),
      ),
    ).toEqual(['gender']);
    expect(
      identityMismatches(
        contract({ enteredGender: null }),
        account({ gender: null }),
      ),
    ).toEqual(['gender']);
  });
});
