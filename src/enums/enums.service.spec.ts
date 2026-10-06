import { NotFoundException } from '@nestjs/common';
import { EnumSource, EnumsService } from './enums.service';

const db: EnumSource = {
  ContractStatus: [
    ['PENDING_SEND', '발송 대기'],
    ['SIGNED', '체결 완료'],
  ],
};
const api: EnumSource = {
  UserType: [
    ['staff', '직원'],
    ['customer', '관리자'],
  ],
};

describe('EnumsService', () => {
  it('DB enum 과 API 전용 enum 을 한 목록으로 합친다', () => {
    const s = new EnumsService(db, api);
    expect(Object.keys(s.all().enums).sort()).toEqual([
      'ContractStatus',
      'UserType',
    ]);
  });

  // order 는 화면 선택지 순서다. 정의한 순서를 그대로 1부터 센다.
  it('값마다 value · label · order 를 정의 순서대로 준다', () => {
    const s = new EnumsService(db, api);
    expect(s.all().enums.ContractStatus).toEqual([
      { value: 'PENDING_SEND', label: '발송 대기', order: 1 },
      { value: 'SIGNED', label: '체결 완료', order: 2 },
    ]);
  });

  // version 은 내용 해시다. 배포를 새로 해도 내용이 같으면 클라이언트 캐시를 버리지 않는다.
  it('내용이 같으면 version 이 같고, 한글 하나만 바뀌어도 version 이 바뀐다', () => {
    const v1 = new EnumsService(db, api).all().version;
    const v2 = new EnumsService(
      { ContractStatus: [...db.ContractStatus] },
      api,
    ).all().version;
    const v3 = new EnumsService(
      {
        ContractStatus: [
          ['PENDING_SEND', '발송 전'],
          ['SIGNED', '체결 완료'],
        ],
      },
      api,
    ).all().version;
    expect(v2).toBe(v1);
    expect(v3).not.toBe(v1);
  });

  it('하나만 조회하면 같은 version 과 그 enum 하나만 준다', () => {
    const s = new EnumsService(db, api);
    expect(s.one('UserType')).toEqual({
      version: s.all().version,
      enums: {
        UserType: [
          { value: 'staff', label: '직원', order: 1 },
          { value: 'customer', label: '관리자', order: 2 },
        ],
      },
    });
  });

  it('없는 이름이면 NotFoundException', () => {
    expect(() => new EnumsService(db, api).one('Nope')).toThrow(
      NotFoundException,
    );
  });

  // 같은 이름이 두 곳에 있으면 어느 한글이 나갈지 정해지지 않는다. 띄울 때 막는다.
  it('DB enum 과 API 전용 enum 의 이름이 겹치면 만들 때 던진다', () => {
    expect(
      () => new EnumsService(db, { ContractStatus: [['X', 'x']] }),
    ).toThrow(/ContractStatus/);
  });
});
