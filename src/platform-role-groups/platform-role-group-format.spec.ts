import { ConflictException } from '@nestjs/common';
import { API_ENUMS } from '../enums/api-enums';
import {
  nextRoleCode,
  roleGroupLabel,
  sortPlatformRoleGroups,
} from './platform-role-group-format';

describe('nextRoleCode', () => {
  it('처음이면 000001', () => {
    expect(nextRoleCode('PA', null)).toBe('PA000001');
  });

  it('지운 것을 포함한 마지막 코드의 다음 — 지운 번호를 다시 쓰지 않는다', () => {
    expect(nextRoleCode('PA', 'PA000009')).toBe('PA000010');
  });

  it('999999 를 넘으면 409', () => {
    expect(() => nextRoleCode('PA', 'PA999999')).toThrow(ConflictException);
  });
});

describe('roleGroupLabel', () => {
  it('이름 코드', () => {
    expect(
      roleGroupLabel({ name: '고객지원 담당', roleCode: 'PA000002' }),
    ).toBe('고객지원 담당 PA000002');
  });
});

describe('API 전용 enum 등록', () => {
  it('칸이 막힌 이유와 상세의 막힌 이유를 GET /enums 에 싣는다 — 값 순서는 상수 그대로', () => {
    expect(API_ENUMS.PlatformRoleMenuBlockReason?.map(([v]) => v)).toEqual([
      'PM_FIXED',
      'READ_ONLY',
      'SELF_LINKED',
      'PLATFORM_MENU_FOR_BP',
      'OUT_OF_SCOPE',
    ]);
    expect(API_ENUMS.PlatformRoleGroupLockReason?.map(([v]) => v)).toEqual([
      'FIXED_ROLE',
      'NO_PERMISSION',
      'SELF_LINKED',
    ]);
  });
});

describe('sortPlatformRoleGroups', () => {
  it('고정 권한 PM · PA · BM · FM 다음 추가 권한을 코드 순으로', () => {
    const rows = [
      { roleCode: 'PA000003', roleTypeCode: 'PA', isMaster: false },
      { roleCode: 'FM000001', roleTypeCode: 'FM', isMaster: true },
      { roleCode: 'PA000002', roleTypeCode: 'PA', isMaster: false },
      { roleCode: 'BM000001', roleTypeCode: 'BM', isMaster: true },
      { roleCode: 'PA000001', roleTypeCode: 'PA', isMaster: true },
      { roleCode: 'PM000001', roleTypeCode: 'PM', isMaster: true },
    ];
    expect(sortPlatformRoleGroups(rows).map((r) => r.roleCode)).toEqual([
      'PM000001',
      'PA000001',
      'BM000001',
      'FM000001',
      'PA000002',
      'PA000003',
    ]);
  });
});
