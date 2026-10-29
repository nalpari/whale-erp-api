import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ACCESS_DENIED_MESSAGE,
  ACCOUNT_UNAVAILABLE_MESSAGE,
} from '../auth/access-messages';
import {
  BP_NOT_FOUND_MESSAGE,
  OTHER_BP_MESSAGE,
  type TargetBpContext,
} from '../auth/menu-permission.guard';
import { hashPassword } from '../auth/password';
import { sameMillisecond } from '../common/updated-at';
import {
  afterCommit,
  voidTempPasswordsForEmailChange,
  issueTempPassword,
  LOCKED_PASSWORD,
  markSent,
  sendPassword,
} from '../platform-admins/admin-password';
import type { PageDto } from '../platform-admins/dto/list-platform-admins.dto';
import {
  PLATFORM_ADMIN_MAIL,
  type PlatformAdminMail,
} from '../platform-admins/platform-admin-mail';
import { generateTempPassword } from '../platform-admins/temp-password';
import { PrismaService } from '../prisma/prisma.service';
import {
  actionsOf,
  assertSelfEdit,
  BP_ADMIN_ROLES,
  type BpAdminCaller,
  type BpAdminRole,
  type BpAdminTarget,
  canSee,
  creatableRoles,
  planStores,
  shrinkCascade,
  sideOf,
} from './bp-admin-rules';
import type {
  BpAdminDetailResponseDto,
  BpAdminHistoryListResponseDto,
  BpAdminListResponseDto,
  BpAdminRoleGroupListResponseDto,
  BpAdminStoreOptionListResponseDto,
  BpAdminSummaryResponseDto,
  BpAdminUpdateImpactResponseDto,
  CreateBpAdminResponseDto,
  ResetBpAdminPasswordResponseDto,
} from './dto/bp-admin.response.dto';
import type {
  BpAdminStoreOptionsQueryDto,
  BpAdminUpdateImpactQueryDto,
  ListBpAdminsDto,
  StoreType,
} from './dto/list-bp-admins.dto';
import type {
  CreateBpAdminDto,
  UpdateBpAdminDto,
} from './dto/save-bp-admin.dto';

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaService;
type History = {
  field: string;
  beforeValue: string | null;
  afterValue: string | null;
};
type Caller = BpAdminCaller & { franchiseMasterId: number | null };

/** 가맹 마스터의 고정 권한. 플랫폼 BP 에 하나 있고 모든 BP 의 가맹 마스터가 쓴다(BM000001 과 같다). */
const FM_ROLE_CODE = 'FM000001';
const STATUS_LABEL: Record<string, string> = {
  ACTIVE: '사용',
  INACTIVE: '미사용',
};
const NOT_FOUND = '관리자 계정을 찾을 수 없습니다';
const ROLE_GROUP_INVALID = '선택할 수 없는 권한입니다.';
const LOGIN_ID_TAKEN = '사용할 수 없는 아이디라 계정을 만들지 않았습니다';
const EMAIL_TAKEN = '사용 중이거나 미사용인 다른 관리자 계정의 이메일입니다';
const CHANGED_MEANWHILE = '다른 사용자가 이 계정을 먼저 바꿨습니다';
const BP_INACTIVE = 'BP 가 사용 중이 아니라 사용 계정을 둘 수 없습니다';
const BP_BUSY =
  '다른 작업이 끝나기를 기다리다 시간이 지났습니다. 잠시 뒤 다시 저장해 주세요';
const BY_FM_DEACTIVATION = ' (가맹 마스터 미사용)';
const BY_FM_SHRINK = ' (가맹 마스터 점포 제외)';

const liveMappings = {
  where: { isDeleted: false, store: { isDeleted: false } },
  select: { storeId: true },
} as const;
const roleGroupSelect = {
  roleGroupId: true,
  roleCode: true,
  name: true,
  roleTypeCode: true,
} as const;
const callerSelect = {
  adminAccountId: true,
  roleTypeCode: true,
  bpCodeId: true,
  isAllStores: true,
  bpCode: { select: { isPlatform: true } },
  roleGroup: { select: { managerAdminAccountId: true } },
  storeMappings: liveMappings,
} as const;
const targetSelect = {
  adminAccountId: true,
  loginId: true,
  name: true,
  phone: true,
  email: true,
  roleTypeCode: true,
  roleGroupId: true,
  roleGroup: {
    select: { ...roleGroupSelect, managerAdminAccountId: true },
  },
  accountStatusCode: true,
  isAllStores: true,
  lastLoginAt: true,
  createdAt: true,
  isInitialPasswordUnsent: true,
  statusChangedAt: true,
  updatedAt: true,
  creator: { select: { name: true } },
  updater: { select: { name: true } },
  storeMappings: liveMappings,
} as const;
type TargetRow = Prisma.AdminAccountGetPayload<{ select: typeof targetSelect }>;

/**
 * BP 관리자 관리 (MN000012 · S-AJHXFU 목록 · S-NIMSMQ 등록 · S-EBIPGZ 상세 · S-OENTFQ 수정 · S-TKSRJX 초기화).
 * 대상 BP 의 BP 관리자 · 가맹 마스터 · 가맹 관리자 계정을 다룬다. 메뉴 권한과 대상 BP 는 가드가 먼저 정하고,
 * 여기서는 호출자의 역할 · 관리 점포로 볼 수 있는지와 고칠 수 있는지를 가른다(bp-admin-rules).
 *
 * 가맹 관리자의 연결 가맹 마스터는 그 권한 그룹의 관리계정이다 — 계정 칸이 따로 없다.
 * 계정 삭제 · 잠금 해제는 없다(계정 회수 기능 없음, 2026-09-29).
 */
@Injectable()
export class BpAdminsService {
  private readonly logger = new Logger(BpAdminsService.name);

  constructor(
    private readonly prisma: PrismaService,
    /** 비밀번호 메일을 보낼 수단. 메일 설정이 없는 환경이면 null — 등록은 「미발송」으로 남고 초기화는 503. */
    @Inject(PLATFORM_ADMIN_MAIL) private readonly sender: PlatformAdminMail,
  ) {}

  async list(
    callerId: number,
    bp: TargetBpContext,
    query: ListBpAdminsDto,
  ): Promise<BpAdminListResponseDto> {
    const caller = await this.loadCaller(this.prisma, callerId, bp);
    const { keyword, storeIds, storeTypeCode, roleGroupId, accountStatus } =
      query;
    const and: Prisma.AdminAccountWhereInput[] = [];
    if (caller.side !== 'HQ')
      and.push({
        OR: [
          { adminAccountId: caller.adminAccountId },
          {
            roleTypeCode: 'FA',
            storeMappings: {
              some: { storeId: { in: caller.storeIds }, isDeleted: false },
            },
          },
          // 연결 가맹 마스터는 자기 가맹 관리자를 점포와 관계없이 본다(canSee 와 같다)
          ...(caller.side === 'FM'
            ? [
                {
                  roleTypeCode: 'FA',
                  roleGroup: { managerAdminAccountId: caller.adminAccountId },
                },
              ]
            : []),
        ],
      });
    if (storeIds?.length || storeTypeCode)
      and.push(managingStores(storeIds, storeTypeCode));
    if (keyword)
      and.push({
        OR: [
          { loginId: { contains: keyword, mode: 'insensitive' } },
          { name: { contains: keyword, mode: 'insensitive' } },
        ],
      });
    const where: Prisma.AdminAccountWhereInput = {
      bpCodeId: bp.bpCodeId,
      isDeleted: false,
      roleTypeCode: { in: [...BP_ADMIN_ROLES] },
      accountStatusCode: accountStatus ?? { in: ['ACTIVE', 'INACTIVE'] },
      ...(roleGroupId && { roleGroupId }),
      AND: and,
    };
    const [rows, total, inactiveCount] = await this.prisma.$transaction([
      this.prisma.adminAccount.findMany({
        where,
        select: {
          adminAccountId: true,
          loginId: true,
          name: true,
          roleTypeCode: true,
          roleGroup: { select: roleGroupSelect },
          accountStatusCode: true,
          isAllStores: true,
          createdAt: true,
          lastLoginAt: true,
          isInitialPasswordUnsent: true,
          // _count 의 관계는 where 만 받는다 — select 를 넘기면 런타임에 SelectionSetOnScalar 로 터진다
          _count: { select: { storeMappings: { where: liveMappings.where } } },
        },
        orderBy: [{ createdAt: 'desc' }, { adminAccountId: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.adminAccount.count({ where }),
      // 「미사용 N」은 상태 조건을 덮어쓴다 — 사용만 골라 봐도 미사용이 몇인지 보인다.
      this.prisma.adminAccount.count({
        where: { ...where, accountStatusCode: 'INACTIVE' },
      }),
    ]);
    return {
      items: rows.map((row) =>
        summaryOf({ ...row, storeCount: row._count.storeMappings }),
      ),
      total,
      inactiveCount,
    };
  }

  /**
   * 권한 그룹 선택지 — 목록 필터와 등록 · 수정 폼이 쓴다. MN000013 권한 없이 받아야 해서 따로 둔다.
   * 본사는 이 BP 의 BA 그룹 · 고정 FM000001 · 이 BP 의 FA 그룹, 가맹 쪽은 연결 가맹 마스터의 FA 그룹(가맹 마스터는
   * 자기 고정 권한도)만이다.
   */
  async roleGroups(
    callerId: number,
    bp: TargetBpContext,
    roleTypeCode?: BpAdminRole,
  ): Promise<BpAdminRoleGroupListResponseDto> {
    const caller = await this.loadCaller(this.prisma, callerId, bp);
    const roles = roleTypeCode ? [roleTypeCode] : [...BP_ADMIN_ROLES];
    const base = { bpCodeId: bp.bpCodeId, isDeleted: false, isMaster: false };
    const or: Prisma.RoleGroupWhereInput[] = [];
    if (roles.includes('BA') && caller.side === 'HQ')
      or.push({ ...base, roleTypeCode: 'BA' });
    if (roles.includes('FM') && caller.side !== 'FA')
      or.push({ roleCode: FM_ROLE_CODE, isDeleted: false });
    if (roles.includes('FA'))
      or.push({
        ...base,
        roleTypeCode: 'FA',
        ...(caller.side !== 'HQ' && {
          managerAdminAccountId: caller.franchiseMasterId ?? -1,
        }),
      });
    if (!or.length) return { items: [] };
    const rows = await this.prisma.roleGroup.findMany({
      where: { OR: or },
      select: roleGroupSelect,
      orderBy: [{ roleTypeCode: 'asc' }, { roleCode: 'asc' }],
    });
    return { items: rows.map(roleGroupOf) };
  }

  /**
   * 점포 선택지 — 호출자의 관리 점포 중 고를 수 있는 것만. 가맹 관리자는 가맹 마스터 본인의 점포 안에서만 고른다. 폐점은
   * 빼고, 가맹 마스터 선택지에서는 다른 사용 중 가맹 마스터가 맡은 점포도 뺀다(한 점포 한 명, 2026-10-23).
   */
  async storeOptions(
    callerId: number,
    bp: TargetBpContext,
    { roleTypeCode, adminAccountId }: BpAdminStoreOptionsQueryDto,
  ): Promise<BpAdminStoreOptionListResponseDto> {
    const caller = await this.loadCaller(this.prisma, callerId, bp);
    const pool =
      roleTypeCode === 'FA'
        ? caller.side === 'FM'
          ? caller.storeIds
          : []
        : caller.side === 'HQ'
          ? caller.storeIds
          : [];
    if (!pool.length) return { items: [] };
    // 저장 때도 다시 막는다 — 후보 목록은 동시에 저장하는 두 사람을 막지 못한다.
    const stores = await this.prisma.store.findMany({
      where: {
        storeId: { in: pool },
        bpCodeId: bp.bpCodeId,
        isDeleted: false,
        storeStatusCode: { not: 'CLOSED' },
      },
      select: {
        storeId: true,
        storeCode: true,
        name: true,
        storeTypeCode: true,
        storeStatusCode: true,
      },
      orderBy: [{ name: 'asc' }, { storeId: 'asc' }],
    });
    const taken =
      roleTypeCode === 'FM'
        ? await this.franchiseMastersAt(
            this.prisma,
            bp.bpCodeId,
            pool,
            adminAccountId,
          )
        : new Map<number, AccountRef>();
    return {
      items: stores
        .filter((s) => !taken.has(s.storeId))
        .map((s) => ({ ...s, storeTypeCode: s.storeTypeCode as StoreType })),
    };
  }

  /** 아이디를 쓸 수 있는가. 삭제 · 탈퇴한 계정까지 모든 관리자 계정(플랫폼 포함)과 겹치면 안 된다. */
  async isLoginIdAvailable(loginId: string): Promise<boolean> {
    const row = await this.prisma.adminAccount.findFirst({
      where: { loginId },
      select: { adminAccountId: true },
    });
    return row === null;
  }

  /** 이메일을 쓸 수 있는가. 저장 409 와 같은 기준 — 지우지 않은 사용 · 미사용 관리자 계정(플랫폼 포함)과 겹치면 안 된다. */
  async isEmailAvailable(email: string): Promise<boolean> {
    return (await this.findEmailOwner(this.prisma, email)) === null;
  }

  async detail(
    callerId: number,
    bp: TargetBpContext,
    adminAccountId: number,
  ): Promise<BpAdminDetailResponseDto> {
    const caller = await this.loadCaller(this.prisma, callerId, bp);
    const { row, target } = await this.loadTarget(
      this.prisma,
      caller,
      bp.bpCodeId,
      adminAccountId,
    );
    const [stores, bpStoreCount, franchiseMaster] = await Promise.all([
      this.prisma.store.findMany({
        where: { storeId: { in: target.storeIds } },
        select: {
          storeId: true,
          storeCode: true,
          name: true,
          storeStatusCode: true,
        },
        orderBy: [{ name: 'asc' }, { storeId: 'asc' }],
      }),
      this.prisma.store.count({
        where: { bpCodeId: bp.bpCodeId, isDeleted: false },
      }),
      target.franchiseMasterId === null
        ? null
        : this.prisma.adminAccount.findFirst({
            where: { adminAccountId: target.franchiseMasterId },
            select: { adminAccountId: true, loginId: true, name: true },
          }),
    ]);
    return {
      ...summaryOf({ ...row, storeCount: target.storeIds.length }),
      phone: row.phone,
      email: row.email,
      statusChangedAt: row.statusChangedAt,
      createdByName: row.creator?.name ?? null,
      updatedAt: row.updatedAt,
      updatedByName: row.updater?.name ?? null,
      bpStoreCount,
      stores: stores.map((s) => ({
        ...s,
        isOutOfScope: !caller.storeIds.includes(s.storeId),
      })),
      franchiseMaster: franchiseMaster && {
        adminAccountId: franchiseMaster.adminAccountId,
        loginId: franchiseMaster.loginId,
        name: franchiseMaster.name,
      },
      actions: actionsOf(caller, target),
    };
  }

  async histories(
    callerId: number,
    bp: TargetBpContext,
    adminAccountId: number,
    { page, pageSize }: PageDto,
  ): Promise<BpAdminHistoryListResponseDto> {
    const caller = await this.loadCaller(this.prisma, callerId, bp);
    await this.loadTarget(this.prisma, caller, bp.bpCodeId, adminAccountId);
    const where = { adminAccountId };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.adminChangeHistory.findMany({
        where,
        select: {
          changeId: true,
          field: true,
          beforeValue: true,
          afterValue: true,
          changedAt: true,
          changer: { select: { name: true } },
        },
        orderBy: [{ changedAt: 'desc' }, { changeId: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.adminChangeHistory.count({ where }),
    ]);
    return {
      items: rows.map(({ changer, ...row }) => ({
        ...row,
        changedByName: changer?.name ?? null,
      })),
      total,
    };
  }

  /**
   * 가맹 마스터를 저장하기 전 확인창의 수 — 함께 미사용이 되는 사용 중 가맹 관리자, 점포 매핑이 빠지는 가맹 관리자.
   * 점포는 저장과 같게 호출자 범위 밖의 매핑은 빠지지 않는 것으로 센다.
   */
  async updateImpact(
    callerId: number,
    bp: TargetBpContext,
    adminAccountId: number,
    { accountStatus, storeIds }: BpAdminUpdateImpactQueryDto,
  ): Promise<BpAdminUpdateImpactResponseDto> {
    const caller = await this.loadCaller(this.prisma, callerId, bp);
    const { row, target } = await this.loadTarget(
      this.prisma,
      caller,
      bp.bpCodeId,
      adminAccountId,
    );
    if (target.roleTypeCode !== 'FM')
      throw new BadRequestException('가맹 마스터 계정만 확인합니다');
    if (!actionsOf(caller, target).canUpdate)
      throw new ForbiddenException(ACCESS_DENIED_MESSAGE);
    const linked = await this.linkedFranchiseAdmins(
      this.prisma,
      bp.bpCodeId,
      adminAccountId,
    );
    const deactivated =
      accountStatus === 'INACTIVE' && row.accountStatusCode === 'ACTIVE'
        ? linked.filter((a) => a.accountStatusCode === 'ACTIVE')
        : [];
    const removed = target.storeIds.filter(
      (id) => caller.storeIds.includes(id) && !storeIds.includes(id),
    );
    const unmappedIds = new Set(
      shrinkCascade(removed, linked).map((a) => a.adminAccountId),
    );
    const unmapped = linked.filter((a) => unmappedIds.has(a.adminAccountId));
    return {
      deactivatedCount: deactivated.length,
      firstDeactivatedLoginId: deactivated[0]?.loginId ?? null,
      unmappedCount: unmapped.length,
      firstUnmappedLoginId: unmapped[0]?.loginId ?? null,
    };
  }

  /**
   * 등록. 늘 사용 · 플랫폼등록으로 만들고 쓸 수 있는 비밀번호는 두지 않는다 — 첫 로그인은 메일로만 보낸 1시간짜리
   * 초기 비밀번호로 한다. 「초기 비밀번호 미발송」으로 만들어 두고 메일이 나간 뒤에야 내린다(플랫폼 관리자와 같다).
   * 가맹 관리자의 연결 가맹 마스터는 등록하는 가맹 마스터 본인이고, 권한 그룹으로 정해진다.
   */
  async create(
    callerId: number,
    bp: TargetBpContext,
    raw: CreateBpAdminDto,
  ): Promise<CreateBpAdminResponseDto> {
    // DB 가 소문자만 받는다(CHECK admin_accounts_email_lower). DTO 를 거치지 않은 호출도 맞춘다.
    const input = { ...raw, email: raw.email.toLowerCase() };
    const caller = await this.loadCaller(this.prisma, callerId, bp);
    const role = input.roleTypeCode;
    if (!creatableRoles(caller).includes(role))
      throw new ForbiddenException('이 역할의 계정을 등록할 권한이 없습니다');
    const group = await this.findAssignableGroup(
      this.prisma,
      bp.bpCodeId,
      role,
      input.roleGroupId,
      role === 'FA' ? caller.adminAccountId : null,
    );
    if (!(await this.isLoginIdAvailable(input.loginId)))
      throw new ConflictException(LOGIN_ID_TAKEN);
    if (await this.findEmailOwner(this.prisma, input.email))
      throw new ConflictException(EMAIL_TAKEN);
    const stores = planStores({
      caller,
      role,
      requested: input,
      allowed: new Set(caller.storeIds),
      closed: await this.closedStores(this.prisma, input.storeIds),
    });

    // 메일에 쓸 상호명은 커밋 전에 읽는다 — 커밋 뒤에 실패하면 계정은 생겼는데 500 이라 다시 등록이 아이디 409 가 된다.
    const bpCode = await this.prisma.bpCode.findFirst({
      where: { bpCodeId: bp.bpCodeId },
      select: { tradeName: true },
    });
    const password = generateTempPassword();
    const passwordHash = await hashPassword(password);
    const by = caller.adminAccountId;
    const { adminAccountId, issuedId } = await this.prisma
      .$transaction(async (tx) => {
        await this.lockBp(tx, bp.bpCodeId, true);
        // 가맹 관리자는 연결 가맹 마스터(호출자)의 점포 안이어야 한다 — 마스터 행을 잠그고 다시 읽은 값으로 다시 본다.
        let saved = stores;
        if (role === 'FA') {
          const master = await this.lockFranchiseMaster(tx, callerId, bp);
          saved = planStores({
            caller: master,
            role,
            requested: input,
            allowed: new Set(master.storeIds),
            closed: await this.closedStores(tx, input.storeIds),
          });
        }
        await this.lockRoleGroup(tx, group.roleGroupId);
        if (role === 'FM')
          await this.assertStoresFree(tx, bp.bpCodeId, stores.storeIds);
        const { adminAccountId: id } = await tx.adminAccount.create({
          data: {
            loginId: input.loginId,
            name: input.name,
            phone: input.phone,
            email: input.email,
            bpCodeId: bp.bpCodeId,
            roleGroupId: group.roleGroupId,
            roleTypeCode: role,
            isAllStores: saved.isAllStores,
            passwordHash: LOCKED_PASSWORD,
            isPasswordChangeRequired: true,
            joinPathCode: 'PLATFORM_REGISTERED',
            accountStatusCode: 'ACTIVE',
            isInitialPasswordUnsent: true,
            createdBy: by,
            updatedBy: by,
          },
          select: { adminAccountId: true },
        });
        await this.setMappings(tx, id, [], saved.storeIds, by);
        const issued = await issueTempPassword(
          tx,
          id,
          passwordHash,
          'INITIAL',
          by,
        );
        await record(tx, id, by, [
          {
            field: '계정',
            beforeValue: null,
            afterValue: `${STATUS_LABEL.ACTIVE} · ${roleLabel(group)}`,
          },
          {
            field: '점포',
            beforeValue: null,
            afterValue: await this.storesLabel(tx, saved),
          },
        ]);
        return { adminAccountId: id, issuedId: issued };
      })
      .catch((error: unknown) => {
        // 확인과 INSERT 사이에 같은 아이디 · 이메일이 먼저 들어갔다.
        if (isUniqueViolation(error))
          throw new ConflictException(
            '이미 사용 중인 아이디 또는 이메일입니다',
          );
        if (isTxTimeout(error)) throw this.busy('등록', bp.bpCodeId, error);
        throw error;
      });

    const isMailSent = await sendPassword(
      this.sender,
      this.logger,
      adminAccountId,
      by,
      {
        templateCode: 'EMAIL_BP_ADMIN_CREATE',
        to: input.email,
        variables: {
          관리자이름: input.name,
          BP이름: bpCode?.tradeName ?? '',
          로그인아이디: input.loginId,
          임시비밀번호: password,
        },
      },
    );
    if (isMailSent)
      await afterCommit(
        this.logger,
        adminAccountId,
        '미발송 해제(isInitialPasswordUnsent=false)',
        () => markSent(this.prisma, adminAccountId, issuedId),
      );
    return { adminAccountId, isMailSent };
  }

  /**
   * 수정. 상세에서 받은 최종수정일시와 같을 때만 고친다 — 그 사이 다른 사람이 고쳤으면 409.
   * 가맹 마스터를 미사용으로 바꾸면 연결된 사용 중 가맹 관리자도 미사용이 되고, 가맹 마스터의 점포를 빼면 연결 가맹
   * 관리자의 그 점포 매핑도 빠진다(2026-10-23). 둘 다 같은 트랜잭션이고, 이력의 처리자는 저장한 사람이다.
   * 미사용으로 바꿔도 세션은 끊지 않는다 — 다음 요청부터 메뉴 권한 판정에서 막힌다.
   */
  async update(
    callerId: number,
    bp: TargetBpContext,
    adminAccountId: number,
    raw: UpdateBpAdminDto,
  ): Promise<void> {
    const input = { ...raw, email: raw.email.toLowerCase() };
    const caller = await this.loadCaller(this.prisma, callerId, bp);
    const by = caller.adminAccountId;
    await this.prisma
      .$transaction(async (tx) => {
        await this.lockBp(tx, bp.bpCodeId, input.accountStatus === 'ACTIVE');
        const { row, target } = await this.loadTarget(
          tx,
          caller,
          bp.bpCodeId,
          adminAccountId,
        );
        const actions = actionsOf(caller, target);
        if (!actions.canUpdate)
          throw new ForbiddenException('이 계정을 고칠 권한이 없습니다');
        const role = target.roleTypeCode;
        const isStatusChanged = input.accountStatus !== row.accountStatusCode;
        const isRoleGroupChanged = input.roleGroupId !== row.roleGroupId;
        assertSelfEdit(actions.isSelf, {
          roleGroupChanged: isRoleGroupChanged,
          statusChanged: isStatusChanged,
          storesChanged:
            input.isAllStores !== target.isAllStores ||
            (!input.isAllStores && !sameIds(input.storeIds, target.storeIds)),
        });

        const group = isRoleGroupChanged
          ? await this.findAssignableGroup(
              tx,
              bp.bpCodeId,
              role,
              input.roleGroupId,
              target.franchiseMasterId,
            )
          : row.roleGroup;
        // 가맹 관리자는 연결 가맹 마스터만 고친다 — 그 마스터 행을 잠그고 다시 읽은 점포 · 상태로 판정한다.
        // 잠금 순서는 등록과 같다: BP 행 → 가맹 마스터 행 → 권한 그룹 행.
        const decider =
          role === 'FA'
            ? await this.lockFranchiseMaster(tx, callerId, bp)
            : caller;
        if (isRoleGroupChanged) await this.lockRoleGroup(tx, group.roleGroupId);
        const stores = actions.isSelf
          ? { isAllStores: target.isAllStores, storeIds: target.storeIds }
          : planStores({
              caller: decider,
              role,
              requested: input,
              current: target,
              allowed: new Set(decider.storeIds),
              closed: await this.closedStores(tx, input.storeIds),
            });

        if (
          input.email !== row.email &&
          (await this.findEmailOwner(tx, input.email, adminAccountId))
        )
          throw new ConflictException(EMAIL_TAKEN);
        if (role === 'FM') {
          // 다시 사용으로 돌리면 그 사이 다른 가맹 마스터가 맡았을 수 있어 점포 전부를 본다.
          const reactivated =
            isStatusChanged && input.accountStatus === 'ACTIVE';
          const checked = reactivated
            ? stores.storeIds
            : stores.storeIds.filter((id) => !target.storeIds.includes(id));
          if (input.accountStatus === 'ACTIVE' && checked.length)
            await this.assertStoresFree(
              tx,
              bp.bpCodeId,
              checked,
              adminAccountId,
            );
        }

        const { count } = await tx.adminAccount.updateMany({
          where: {
            adminAccountId,
            updatedAt: sameMillisecond(input.updatedAt),
          },
          data: {
            name: input.name,
            phone: input.phone,
            email: input.email,
            roleGroupId: group.roleGroupId,
            isAllStores: stores.isAllStores,
            accountStatusCode: input.accountStatus,
            ...(isStatusChanged && { statusChangedAt: new Date() }),
            updatedBy: by,
          },
        });
        if (count === 0) throw new ConflictException(CHANGED_MEANWHILE);
        await this.setMappings(
          tx,
          adminAccountId,
          target.storeIds,
          stores.storeIds,
          by,
        );
        // 옛 주소로 나간 임시 비밀번호는 옛 주소의 주인이 쓸 수 있다 — 막고 「미발송」을 켜 초기화하게 한다.
        if (input.email !== row.email)
          await voidTempPasswordsForEmailChange(tx, adminAccountId, by);

        const storesChanged =
          stores.isAllStores !== target.isAllStores ||
          !sameIds(stores.storeIds, target.storeIds);
        await record(tx, adminAccountId, by, [
          change('이름', row.name, input.name),
          change('휴대전화', row.phone, input.phone),
          change('이메일', row.email, input.email),
          change('권한 그룹', roleLabel(row.roleGroup), roleLabel(group)),
          storesChanged
            ? {
                field: '점포',
                beforeValue: await this.storesLabel(tx, target),
                afterValue: await this.storesLabel(tx, stores),
              }
            : null,
          change(
            '계정 상태',
            STATUS_LABEL[row.accountStatusCode],
            STATUS_LABEL[input.accountStatus],
          ),
        ]);

        if (role === 'FM')
          await this.cascadeFromMaster(tx, bp.bpCodeId, adminAccountId, by, {
            deactivated: isStatusChanged && input.accountStatus === 'INACTIVE',
            removedStoreIds: target.storeIds.filter(
              (id) => !stores.storeIds.includes(id),
            ),
          });
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw new ConflictException(EMAIL_TAKEN);
        if (isTxTimeout(error)) throw this.busy('수정', bp.bpCodeId, error);
        throw error;
      });
  }

  /**
   * 비밀번호 초기화. 기존 비밀번호 · 앞서 낸 임시 비밀번호를 막고, 새 1시간짜리 임시 비밀번호를 계정
   * 이메일로만 보낸다. 미사용 계정도 된다(플랫폼 관리자 관리와 같다). 로그인 잠금도 푼다(BP 마스터 · 플랫폼 관리자 초기화와 같다). 계정 상태와 세션은 그대로다.
   */
  async resetPassword(
    callerId: number,
    bp: TargetBpContext,
    adminAccountId: number,
  ): Promise<ResetBpAdminPasswordResponseDto> {
    const caller = await this.loadCaller(this.prisma, callerId, bp);
    const { row, target } = await this.loadTarget(
      this.prisma,
      caller,
      bp.bpCodeId,
      adminAccountId,
    );
    const actions = actionsOf(caller, target);
    if (actions.isSelf)
      throw new ForbiddenException('본인 비밀번호는 내 정보에서 바꿔 주세요');
    if (!actions.canResetPassword)
      throw new ForbiddenException(
        '이 계정의 비밀번호를 초기화할 권한이 없습니다',
      );
    if (!row.email)
      throw new ConflictException('이메일이 없는 계정이라 보낼 곳이 없습니다');
    // 초기화는 기존 비밀번호를 지운다. 새 비밀번호를 보낼 길이 없으면 계정이 잠기므로 아무것도 쓰지 않는다.
    if (this.sender === null)
      throw new ServiceUnavailableException(
        '메일 설정이 없어 비밀번호를 초기화할 수 없습니다',
      );

    const by = caller.adminAccountId;
    const password = generateTempPassword();
    const passwordHash = await hashPassword(password);
    const issued = await this.prisma.$transaction(async (tx) => {
      // 이메일까지 본다 — 읽은 뒤 바뀌었으면 옛 주소로 비밀번호를 보내게 된다.
      const { count } = await tx.adminAccount.updateMany({
        where: {
          adminAccountId,
          isDeleted: false,
          accountStatusCode: { not: 'WITHDRAWN' },
          roleTypeCode: row.roleTypeCode,
          email: row.email,
        },
        data: {
          passwordHash: LOCKED_PASSWORD,
          isPasswordChangeRequired: true,
          isInitialPasswordUnsent: true,
          failedLoginCount: 0,
          lockExpiresAt: null,
          updatedBy: by,
        },
      });
      if (count === 0) throw new ConflictException(CHANGED_MEANWHILE);
      const issuedId = await issueTempPassword(
        tx,
        adminAccountId,
        passwordHash,
        'RESET',
        by,
      );
      await record(tx, adminAccountId, by, [
        { field: '비밀번호', beforeValue: null, afterValue: '초기화' },
      ]);
      const { updatedAt } = await tx.adminAccount.findUniqueOrThrow({
        where: { adminAccountId },
        select: { updatedAt: true },
      });
      return { issuedId, updatedAt };
    });
    let { updatedAt } = issued;

    const isMailSent = await sendPassword(
      this.sender,
      this.logger,
      adminAccountId,
      by,
      {
        templateCode: 'EMAIL_PASSWORD_RESET',
        to: row.email,
        variables: {
          관리자이름: row.name ?? row.loginId,
          임시비밀번호: password,
        },
      },
    );
    // 미발송을 내리면 updatedAt 이 또 오른다 — 그 사이 다른 저장이 없을 때만 새 값을 준다(플랫폼 관리자와 같다).
    if (isMailSent)
      await afterCommit(
        this.logger,
        adminAccountId,
        '미발송 해제(isInitialPasswordUnsent=false)',
        async () => {
          const sent = await markSent(
            this.prisma,
            adminAccountId,
            issued.issuedId,
          );
          if (sent && sent.before.getTime() === updatedAt.getTime())
            updatedAt = sent.after;
        },
      );
    return { isMailSent, updatedAt };
  }

  /**
   * 호출자. 플랫폼 사용자는 탭에서 고른 고객 BP 의 전체 점포를 맡은 것으로 본다(2026-10-23) — 헤더 없이 부르면
   * 대상이 플랫폼 BP 라 400. BP · 가맹 계정은 소속 BP 만이다(가드가 막지만, 그 사이 소속이 바뀌었을 수 있다).
   */
  private async loadCaller(
    db: Db,
    callerId: number,
    bp: TargetBpContext,
  ): Promise<Caller> {
    const row = await db.adminAccount.findFirst({
      where: {
        adminAccountId: callerId,
        isDeleted: false,
        accountStatusCode: 'ACTIVE',
      },
      select: callerSelect,
    });
    if (!row) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    const side = sideOf(row.roleTypeCode, row.bpCode.isPlatform);
    if (!side) throw new ForbiddenException(ACCESS_DENIED_MESSAGE);
    if (row.bpCode.isPlatform) {
      if (bp.bpCodeId === row.bpCodeId)
        throw new BadRequestException('관리자 계정을 볼 BP 를 골라 주세요');
    } else if (bp.bpCodeId !== row.bpCodeId)
      throw new ForbiddenException(OTHER_BP_MESSAGE);
    const isAllStores = row.bpCode.isPlatform || row.isAllStores;
    const storeIds = isAllStores
      ? (
          await db.store.findMany({
            where: { bpCodeId: bp.bpCodeId, isDeleted: false },
            select: { storeId: true },
            orderBy: { storeId: 'asc' },
          })
        ).map((s) => s.storeId)
      : row.storeMappings.map((m) => m.storeId);
    return {
      adminAccountId: row.adminAccountId,
      side,
      isAllStores,
      storeIds,
      franchiseMasterId:
        side === 'FM'
          ? row.adminAccountId
          : side === 'FA'
            ? row.roleGroup.managerAdminAccountId
            : null,
    };
  }

  /** 대상. 대상 BP 의 지우지 않은 · 탈퇴하지 않은 BA · FM · FA 이고 호출자가 볼 수 있어야 한다 — 아니면 있는지도 알리지 않고 404. */
  private async loadTarget(
    db: Db,
    caller: Caller,
    bpCodeId: number,
    adminAccountId: number,
  ): Promise<{ row: TargetRow; target: BpAdminTarget }> {
    const row = await db.adminAccount.findFirst({
      where: {
        adminAccountId,
        bpCodeId,
        isDeleted: false,
        roleTypeCode: { in: [...BP_ADMIN_ROLES] },
        accountStatusCode: { not: 'WITHDRAWN' },
      },
      select: targetSelect,
    });
    if (!row) throw new NotFoundException(NOT_FOUND);
    const target: BpAdminTarget = {
      adminAccountId: row.adminAccountId,
      roleTypeCode: row.roleTypeCode as BpAdminRole,
      isAllStores: row.isAllStores,
      storeIds: row.storeMappings.map((m) => m.storeId).sort((a, b) => a - b),
      franchiseMasterId:
        row.roleTypeCode === 'FA' ? row.roleGroup.managerAdminAccountId : null,
    };
    if (!canSee(caller, target)) throw new NotFoundException(NOT_FOUND);
    return { row, target };
  }

  /**
   * 줄 수 있는 권한 그룹. BP 관리자는 그 BP 의 지우지 않은 BA 그룹 어느 것이든(권한 상승 검사 없음, 2026-10-23 확정),
   * 가맹 마스터는 고정 FM000001, 가맹 관리자는 연결 가맹 마스터가 관리계정인 FA 그룹. 아니면 400.
   */
  private async findAssignableGroup(
    db: Db,
    bpCodeId: number,
    role: BpAdminRole,
    roleGroupId: number,
    franchiseMasterId: number | null,
  ) {
    const where: Prisma.RoleGroupWhereInput =
      role === 'FM'
        ? { roleGroupId, roleCode: FM_ROLE_CODE, isDeleted: false }
        : {
            roleGroupId,
            bpCodeId,
            roleTypeCode: role,
            isDeleted: false,
            isMaster: false,
            ...(role === 'FA' && {
              managerAdminAccountId: franchiseMasterId ?? -1,
            }),
          };
    const group = await db.roleGroup.findFirst({
      where,
      select: roleGroupSelect,
    });
    if (!group) throw new BadRequestException(ROLE_GROUP_INVALID);
    return group;
  }

  /** 이메일은 지우지 않은 사용 · 미사용 계정끼리 고유하다(부분 고유 인덱스 admin_accounts_email_key). */
  private findEmailOwner(db: Db, email: string, exceptAdminAccountId?: number) {
    return db.adminAccount.findFirst({
      where: {
        email,
        isDeleted: false,
        accountStatusCode: { not: 'WITHDRAWN' },
        ...(exceptAdminAccountId && {
          adminAccountId: { not: exceptAdminAccountId },
        }),
      },
      select: { adminAccountId: true },
    });
  }

  private async closedStores(db: Db, storeIds: number[]): Promise<Set<number>> {
    if (!storeIds.length) return new Set();
    const rows = await db.store.findMany({
      where: { storeId: { in: storeIds }, storeStatusCode: 'CLOSED' },
      select: { storeId: true },
    });
    return new Set(rows.map((r) => r.storeId));
  }

  /** 이 점포들을 맡은 사용 중 가맹 마스터(제외할 계정 빼고). */
  private async franchiseMastersAt(
    db: Db,
    bpCodeId: number,
    storeIds: number[],
    exceptAdminAccountId?: number,
  ): Promise<Map<number, AccountRef>> {
    const rows = await db.adminStoreMapping.findMany({
      where: {
        storeId: { in: storeIds },
        isDeleted: false,
        adminAccount: {
          bpCodeId,
          roleTypeCode: 'FM',
          accountStatusCode: 'ACTIVE',
          isDeleted: false,
          ...(exceptAdminAccountId && {
            adminAccountId: { not: exceptAdminAccountId },
          }),
        },
      },
      select: {
        storeId: true,
        adminAccount: {
          select: { adminAccountId: true, loginId: true, name: true },
        },
      },
    });
    return new Map(rows.map((r) => [r.storeId, r.adminAccount]));
  }

  /**
   * 가맹 관리자 저장 — 연결 가맹 마스터(호출자) 행을 FOR SHARE 로 잠그고 다시 읽는다. 본사의 가맹 마스터 수정은 그 행을
   * UPDATE 한 뒤 연쇄로 연결 가맹 관리자를 읽으므로, 두 저장이 한 줄로 선다 — 마스터 수정이 먼저면 빠진 점포 · 미사용을
   * 보고 400 · 403, 가맹 관리자 저장이 먼저면 연쇄가 방금 붙은 매핑까지 본다(PR #160 적대적 리뷰). 같은 마스터의 가맹
   * 관리자 저장끼리는 FOR SHARE 라 서로 막지 않는다. 마스터 행에는 쓰지 않으므로 잠금을 올리다 교착할 일도 없다.
   * 호출자 일반으로 넓히지 않는다 — 본사 호출자의 틈은 「요청이 조금 일찍 왔다」와 같아 남는 규칙 위반이 없고, 호출자 행을
   * 늘 잠그면 관리자 둘이 서로를 동시에 고칠 때 교착(40P01)한다. 가맹 관리자만 마스터에 묶여 연쇄로 관리된다.
   */
  private async lockFranchiseMaster(
    tx: Tx,
    callerId: number,
    bp: TargetBpContext,
  ): Promise<Caller> {
    await tx.$queryRaw`SELECT 1 FROM admin_accounts WHERE admin_account_id = ${callerId} FOR SHARE`;
    return this.loadCaller(tx, callerId, bp);
  }

  /**
   * 트랜잭션 한도(5초)를 넘긴 저장은 P2028 로 끝난다. 이 PR 이 더한 BP 잠금 대기(미사용 전환 · 삭제가 BP 행을 오래
   * 잡을 때)가 주된 경우지만, 가맹 마스터 · 권한 그룹 잠금이나 연결 대기도 같은 코드다. 장애가 아니라 다시 할 일이라
   * 503 이다(점포 등록과 같다).
   */
  private busy(
    what: string,
    bpCodeId: number,
    error: unknown,
  ): ServiceUnavailableException {
    this.logger.error(
      `BP 관리자 ${what} 트랜잭션 시간 초과 bp=${bpCodeId}`,
      error instanceof Error ? error.stack : String(error),
    );
    return new ServiceUnavailableException(BP_BUSY);
  }

  /**
   * 대상 BP 행을 FOR SHARE 로 잠그고 다시 본다 — 트랜잭션의 첫 잠금이어야 한다. BP 미사용 전환(BpMastersService.changeStatus
   * 의 bp_codes UPDATE = FOR NO KEY UPDATE)과 삭제(remove 의 FOR UPDATE)는 bp_codes → admin_accounts 순서로 잡으므로,
   * 같은 순서로 서야 교착 없이 한 줄로 선다 — 그쪽 순서가 바뀌면 이 논증도 깨진다. 미사용
   * 전환이 먼저면 사용으로 두는 저장(keepsActive)은 409, 이쪽이 먼저면 미사용 전환이 그 계정(새 계정 · 고친 계정)까지
   * 내린다. 삭제가 먼저면 404, 이쪽이 먼저면 삭제가 하위 관리자를 본다(remove 의 deletionReasons 가 409). 등록의 계정 FK 검사(FOR KEY SHARE)로는
   * 모자라 이 잠금이 있다 — 미사용 전환과는 충돌하지 않고, 삭제는 기다리지만 삭제가 행을 남기고 표시만 하므로 그 뒤
   * 그대로 통과한다. 수정은 bp_code_id 를 바꾸지 않아 FK 검사조차 없다(PR #163 리뷰).
   * 사용 중이 아닌 BP(미사용 · 탈퇴)에는 사용 계정을 두지 않는다 — 사용 복원은 BP 마스터 몫이다(WHALEERP-414).
   */
  private async lockBp(
    tx: Tx,
    bpCodeId: number,
    keepsActive: boolean,
  ): Promise<void> {
    const [row] = await tx.$queryRaw<
      { account_status_code: string; is_deleted: boolean }[]
    >`SELECT account_status_code, is_deleted FROM bp_codes WHERE bp_code_id = ${bpCodeId} FOR SHARE`;
    if (!row || row.is_deleted)
      throw new NotFoundException(BP_NOT_FOUND_MESSAGE);
    if (keepsActive && row.account_status_code !== 'ACTIVE')
      throw new ConflictException(BP_INACTIVE);
  }

  /**
   * 고른 권한 그룹을 FOR SHARE 로 잠그고 지워지지 않았는지 다시 본다. 그룹 삭제(BP 권한 그룹 관리)는 그 행을 FOR UPDATE
   * 로 잡은 뒤 연결 계정을 대체 그룹으로 옮기는데, 커밋 전인 새 계정은 옮겨지지 않아 지운 그룹에 붙어 모든 메뉴가 403 이
   * 된다. 삭제가 먼저면 여기서 지워진 것을 보고 400, 이쪽이 먼저면 삭제가 우리 커밋을 기다렸다가 새 계정까지 옮긴다.
   */
  private async lockRoleGroup(tx: Tx, roleGroupId: number): Promise<void> {
    const rows = await tx.$queryRaw<unknown[]>`
      SELECT 1 FROM role_groups WHERE role_group_id = ${roleGroupId} AND NOT is_deleted FOR SHARE`;
    if (!rows.length) throw new BadRequestException(ROLE_GROUP_INVALID);
  }

  /**
   * 한 점포에 사용 중 가맹 마스터 한 명. BP 마다 advisory lock 으로 가맹 마스터 점포 저장을 줄 세운다 — 둘이 같은
   * 점포를 동시에 가져가면 둘 다 빈 점포를 읽고 통과한다.
   */
  private async assertStoresFree(
    tx: Tx,
    bpCodeId: number,
    storeIds: number[],
    exceptAdminAccountId?: number,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`bp-admins:franchise-master-stores:${bpCodeId}`}))`;
    const taken = await this.franchiseMastersAt(
      tx,
      bpCodeId,
      storeIds,
      exceptAdminAccountId,
    );
    if (taken.size) {
      const [, fm] = [...taken][0];
      throw new ConflictException(
        `다른 가맹 마스터(${fm.loginId})가 맡은 점포가 있어 저장하지 않았습니다`,
      );
    }
  }

  /** 연결 가맹 관리자 — 권한 그룹의 관리계정이 이 가맹 마스터인 지우지 않은 · 탈퇴하지 않은 FA. */
  private linkedFranchiseAdmins(
    db: Db,
    bpCodeId: number,
    franchiseMasterId: number,
  ) {
    return db.adminAccount
      .findMany({
        where: {
          bpCodeId,
          roleTypeCode: 'FA',
          isDeleted: false,
          accountStatusCode: { not: 'WITHDRAWN' },
          roleGroup: { managerAdminAccountId: franchiseMasterId },
        },
        select: {
          adminAccountId: true,
          loginId: true,
          accountStatusCode: true,
          storeMappings: liveMappings,
        },
        orderBy: { adminAccountId: 'asc' },
      })
      .then((rows) =>
        rows.map((r) => ({
          ...r,
          storeIds: r.storeMappings.map((m) => m.storeId),
        })),
      );
  }

  /** 가맹 마스터 저장의 연쇄. 처리자는 저장한 사람이고, 이력 값 끝에 이유를 붙인다(이력에 사유 칸이 없다). */
  private async cascadeFromMaster(
    tx: Tx,
    bpCodeId: number,
    franchiseMasterId: number,
    by: number,
    {
      deactivated,
      removedStoreIds,
    }: { deactivated: boolean; removedStoreIds: number[] },
  ): Promise<void> {
    if (!deactivated && !removedStoreIds.length) return;
    const linked = await this.linkedFranchiseAdmins(
      tx,
      bpCodeId,
      franchiseMasterId,
    );
    const active = deactivated
      ? linked.filter((a) => a.accountStatusCode === 'ACTIVE')
      : [];
    if (active.length) {
      await tx.adminAccount.updateMany({
        where: {
          adminAccountId: { in: active.map((a) => a.adminAccountId) },
          accountStatusCode: 'ACTIVE',
        },
        data: {
          accountStatusCode: 'INACTIVE',
          statusChangedAt: new Date(),
          updatedBy: by,
        },
      });
      for (const a of active)
        await record(tx, a.adminAccountId, by, [
          {
            field: '계정 상태',
            beforeValue: STATUS_LABEL.ACTIVE,
            afterValue: STATUS_LABEL.INACTIVE + BY_FM_DEACTIVATION,
          },
        ]);
    }
    const shrunk = shrinkCascade(removedStoreIds, linked);
    // 상태는 그대로 두되 매핑이 바뀌었으니 수정자 · 수정일시(@updatedAt)를 올린다 — 열어 둔 수정 화면의 저장이
    // 낙관적 잠금에 걸려 409 가 되고, 상세의 최종 수정도 맞는다.
    if (shrunk.length)
      await tx.adminAccount.updateMany({
        where: { adminAccountId: { in: shrunk.map((a) => a.adminAccountId) } },
        data: { updatedBy: by },
      });
    for (const a of shrunk) {
      await this.setMappings(tx, a.adminAccountId, a.before, a.after, by);
      await record(tx, a.adminAccountId, by, [
        {
          field: '점포',
          beforeValue: await this.storesLabel(tx, {
            isAllStores: false,
            storeIds: a.before,
          }),
          afterValue:
            (await this.storesLabel(tx, {
              isAllStores: false,
              storeIds: a.after,
            })) + BY_FM_SHRINK,
        },
      ]);
    }
  }

  /** 매핑을 before → after 로. 뺀 것은 지움 표시, 전에 지운 매핑은 되살리고 처음인 것만 만든다(복합 PK). */
  private async setMappings(
    tx: Tx,
    adminAccountId: number,
    before: number[],
    after: number[],
    by: number,
  ): Promise<void> {
    const removed = before.filter((id) => !after.includes(id));
    const added = after.filter((id) => !before.includes(id));
    if (removed.length)
      await tx.adminStoreMapping.updateMany({
        where: { adminAccountId, storeId: { in: removed }, isDeleted: false },
        data: { isDeleted: true, updatedBy: by },
      });
    if (!added.length) return;
    await tx.adminStoreMapping.updateMany({
      where: { adminAccountId, storeId: { in: added }, isDeleted: true },
      data: { isDeleted: false, updatedBy: by },
    });
    await tx.adminStoreMapping.createMany({
      data: added.map((storeId) => ({
        adminAccountId,
        storeId,
        createdBy: by,
      })),
      skipDuplicates: true,
    });
  }

  /** 이력에 쓰는 점포 값 — 「전체 점포」, 이름순 점포명, 없으면 「없음」. */
  private async storesLabel(
    db: Db,
    stores: { isAllStores: boolean; storeIds: number[] },
  ): Promise<string> {
    if (stores.isAllStores) return '전체 점포';
    if (!stores.storeIds.length) return '없음';
    const rows = await db.store.findMany({
      where: { storeId: { in: stores.storeIds } },
      select: { name: true },
      orderBy: [{ name: 'asc' }, { storeId: 'asc' }],
    });
    return rows.map((r) => r.name).join(', ');
  }
}

type AccountRef = {
  adminAccountId: number;
  loginId: string;
  name: string | null;
};

/** 점포 조건 — 그 점포(유형)가 매핑된 계정과 전체 점포 계정. 전체 점포 계정은 어느 점포를 골라도 나온다. */
function managingStores(
  storeIds: number[] | undefined,
  storeTypeCode: StoreType | undefined,
): Prisma.AdminAccountWhereInput {
  return {
    OR: [
      { isAllStores: true },
      {
        storeMappings: {
          some: {
            isDeleted: false,
            store: {
              isDeleted: false,
              ...(storeIds?.length && { storeId: { in: storeIds } }),
              ...(storeTypeCode && { storeTypeCode }),
            },
          },
        },
      },
    ],
  };
}

function roleGroupOf(group: {
  roleGroupId: number;
  roleCode: string;
  name: string;
  roleTypeCode: string;
}) {
  return {
    roleGroupId: group.roleGroupId,
    roleCode: group.roleCode,
    name: group.name,
    roleTypeCode: group.roleTypeCode as BpAdminRole,
  };
}

function summaryOf(row: {
  adminAccountId: number;
  loginId: string;
  name: string | null;
  roleTypeCode: string;
  roleGroup: {
    roleGroupId: number;
    roleCode: string;
    name: string;
    roleTypeCode: string;
  };
  accountStatusCode: string;
  isAllStores: boolean;
  storeCount: number;
  createdAt: Date;
  lastLoginAt: Date | null;
  isInitialPasswordUnsent: boolean;
}): BpAdminSummaryResponseDto {
  return {
    adminAccountId: row.adminAccountId,
    loginId: row.loginId,
    name: row.name,
    roleTypeCode: row.roleTypeCode as BpAdminRole,
    roleGroup: roleGroupOf(row.roleGroup),
    accountStatus: row.accountStatusCode as 'ACTIVE' | 'INACTIVE',
    isAllStores: row.isAllStores,
    storeCount: row.isAllStores ? 0 : row.storeCount,
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt,
    isInitialPasswordUnsent: row.isInitialPasswordUnsent,
  };
}

function roleLabel(group: { name: string; roleCode: string }): string {
  return `${group.name} ${group.roleCode}`;
}

function sameIds(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

function change(
  field: string,
  beforeValue: string | null,
  afterValue: string | null,
): History | null {
  return beforeValue === afterValue ? null : { field, beforeValue, afterValue };
}

/** 바뀐 항목만 이력으로 남긴다. 비밀번호 값은 쓰지 않는다. */
async function record(
  db: Db,
  adminAccountId: number,
  changedBy: number,
  changes: (History | null)[],
): Promise<void> {
  const data = changes
    .filter((c): c is History => c !== null)
    .map((c) => ({ adminAccountId, ...c, changedBy }));
  if (data.length) await db.adminChangeHistory.createMany({ data });
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

function isTxTimeout(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2028'
  );
}
