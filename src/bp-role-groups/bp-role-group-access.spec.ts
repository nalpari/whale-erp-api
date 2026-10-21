// mock 의 호출 인자를 깊이 들여다보는 검사라 any 를 그대로 읽는다.
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { MenuCaller } from '../menu-permissions/menu-permissions.service';
import { NO_FLAGS } from '../platform-role-groups/role-menu-rules';
import {
  bpCellBlock,
  type BpScope,
  canWrite,
  intersectGrants,
  resolveScope,
  visibleWhere,
} from './bp-role-group-access';

const caller = (roleTypeCode: string, adminAccountId = 10): MenuCaller => ({
  adminAccountId,
  roleTypeCode,
  roleGroupId: 100,
});

function db(account: {
  bpCodeId: number;
  isPlatform: boolean;
  managerAdminAccountId?: number | null;
}) {
  return {
    adminAccount: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        bpCodeId: account.bpCodeId,
        bpCode: { isPlatform: account.isPlatform },
        roleGroup: {
          managerAdminAccountId: account.managerAdminAccountId ?? null,
        },
      }),
    },
  } as any;
}

/** 가드가 정한 대상 BP. */
const own = { bpCodeId: 7, isPlatformCaller: false };
const picked = (bpCodeId: number) => ({ bpCodeId, isPlatformCaller: true });

describe('resolveScope', () => {
  it('BM 은 자기 BP 전체를 보고 BA 를 쓴다', async () => {
    const scope = await resolveScope(
      db({ bpCodeId: 7, isPlatform: false }),
      caller('BM'),
      own,
    );
    expect(scope).toMatchObject({
      bpCodeId: 7,
      managerId: null,
      writableType: 'BA',
    });
  });

  it('BA 는 자기 BP 전체를 보고 쓰지 못한다', async () => {
    const scope = await resolveScope(
      db({ bpCodeId: 7, isPlatform: false }),
      caller('BA'),
      own,
    );
    expect(scope).toMatchObject({ managerId: null, writableType: null });
  });

  it('FM 은 본인이 관리계정인 FA 만 보고 FA 를 쓴다', async () => {
    const scope = await resolveScope(
      db({ bpCodeId: 7, isPlatform: false }),
      caller('FM', 30),
      own,
    );
    expect(scope).toMatchObject({ managerId: 30, writableType: 'FA' });
  });

  it('FA 는 연결 가맹 마스터의 FA 만 본다', async () => {
    const scope = await resolveScope(
      db({ bpCodeId: 7, isPlatform: false, managerAdminAccountId: 30 }),
      caller('FA'),
      own,
    );
    expect(scope).toMatchObject({ managerId: 30, writableType: null });
  });

  it('연결 가맹 마스터가 없는 FA 는 403', async () => {
    await expect(
      resolveScope(db({ bpCodeId: 7, isPlatform: false }), caller('FA'), own),
    ).rejects.toThrow(ForbiddenException);
  });

  it('대상 BP 가 소속 BP 와 다르면 403 — 가드 뒤에 소속이 바뀐 경우', async () => {
    await expect(
      resolveScope(db({ bpCodeId: 7, isPlatform: false }), caller('BM'), {
        bpCodeId: 8,
        isPlatformCaller: false,
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('플랫폼 사용자가 헤더 없이 부르면(대상 = 플랫폼 BP) 400', async () => {
    await expect(
      resolveScope(
        db({ bpCodeId: 1, isPlatform: true }),
        caller('PM'),
        picked(1),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('플랫폼 사용자는 가드가 정한 고객 BP 를 읽기만 한다', async () => {
    const d = db({ bpCodeId: 1, isPlatform: true });
    const scope = await resolveScope(d, caller('PA'), picked(7));
    expect(scope).toMatchObject({
      bpCodeId: 7,
      managerId: null,
      writableType: null,
    });
  });

  it('플랫폼 BP 의 BP 쪽 유형 · BP 의 플랫폼 유형은 403', async () => {
    await expect(
      resolveScope(
        db({ bpCodeId: 1, isPlatform: true }),
        caller('BM'),
        picked(7),
      ),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      resolveScope(db({ bpCodeId: 7, isPlatform: false }), caller('PM'), own),
    ).rejects.toThrow(ForbiddenException);
  });
});

const scope = (over: Partial<BpScope> = {}): BpScope => ({
  caller: caller('BM'),
  bpCodeId: 7,
  managerId: null,
  writableType: 'BA',
  ...over,
});

describe('visibleWhere', () => {
  it('BP 전체면 그 BP 의 BA · FA, 고정 권한 · 지운 그룹 제외', () => {
    expect(visibleWhere(scope(), 5)).toEqual({
      roleGroupId: 5,
      bpCodeId: 7,
      isDeleted: false,
      isMaster: false,
      roleTypeCode: { in: ['BA', 'FA'] },
    });
  });

  it('관리계정이 정해지면 그 관리계정의 FA 만', () => {
    expect(visibleWhere(scope({ managerId: 30 }))).toEqual({
      bpCodeId: 7,
      isDeleted: false,
      isMaster: false,
      roleTypeCode: 'FA',
      managerAdminAccountId: 30,
    });
  });
});

describe('canWrite', () => {
  it('쓸 수 있는 유형의 그룹만', () => {
    expect(canWrite(scope(), { roleTypeCode: 'BA' })).toBe(true);
    expect(canWrite(scope(), { roleTypeCode: 'FA' })).toBe(false);
    expect(
      canWrite(scope({ writableType: null }), { roleTypeCode: 'BA' }),
    ).toBe(false);
  });
});

describe('intersectGrants', () => {
  it('두 그룹 모두 켠 칸만 남긴다', () => {
    const a = new Map([
      [1, { read: true, create: true, update: false, delete: true }],
      [2, { ...NO_FLAGS, read: true }],
    ]);
    const b = new Map([
      [1, { read: true, create: false, update: true, delete: true }],
    ]);
    expect(intersectGrants(a, b)).toEqual(
      new Map([
        [1, { read: true, create: false, update: false, delete: true }],
      ]),
    );
  });
});

describe('bpCellBlock', () => {
  const ALL = { read: true, create: true, update: true, delete: true };
  const ctx = {
    canWrite: true,
    isSelfLinked: false,
    ceiling: ALL,
    current: { ...NO_FLAGS },
  };

  it('판정 순서 — READ_ONLY · SELF_LINKED · OUT_OF_SCOPE', () => {
    expect(
      bpCellBlock({ ...ctx, canWrite: false, isSelfLinked: true }, 'read'),
    ).toBe('READ_ONLY');
    expect(
      bpCellBlock({ ...ctx, isSelfLinked: true, ceiling: undefined }, 'read'),
    ).toBe('SELF_LINKED');
    expect(bpCellBlock({ ...ctx, ceiling: undefined }, 'read')).toBe(
      'OUT_OF_SCOPE',
    );
    expect(bpCellBlock(ctx, 'delete')).toBeNull();
  });

  it('상한 밖 칸은 막는다', () => {
    expect(
      bpCellBlock({ ...ctx, ceiling: { ...ALL, delete: false } }, 'delete'),
    ).toBe('OUT_OF_SCOPE');
  });

  it('조회를 끄면 함께 꺼질 칸이 상한 밖이면 조회도 막는다', () => {
    expect(
      bpCellBlock(
        {
          ...ctx,
          ceiling: { ...ALL, delete: false },
          current: { ...ALL },
        },
        'read',
      ),
    ).toBe('OUT_OF_SCOPE');
  });
});
