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
import { hashPassword } from '../auth/password';
import {
  type MenuCaller,
  MenuPermissionsService,
} from '../menu-permissions/menu-permissions.service';
import { PrismaService } from '../prisma/prisma.service';
import type {
  AdminStatus,
  ListPlatformAdminsDto,
  PageDto,
} from './dto/list-platform-admins.dto';
import type {
  CreatePlatformAdminResponseDto,
  PlatformAdminDetailResponseDto,
  PlatformAdminHistoryListResponseDto,
  PlatformAdminListResponseDto,
  PlatformRoleGroupListResponseDto,
  ResetPasswordResponseDto,
} from './dto/platform-admin.response.dto';
import type {
  CreatePlatformAdminDto,
  UpdatePlatformAdminDto,
} from './dto/save-platform-admin.dto';
import {
  afterCommit,
  invalidateTempPasswords,
  issueTempPassword,
  LOCKED_PASSWORD,
  markSent,
  sendPassword,
} from './admin-password';
import { PLATFORM_ROLE_TYPES } from './platform-admin-format';
import {
  PLATFORM_ADMIN_MAIL,
  type PlatformAdminMail,
} from './platform-admin-mail';
import { generateTempPassword } from './temp-password';

type Tx = Prisma.TransactionClient;

const MASTER = 'PM';
const STATUSES: AdminStatus[] = ['ACTIVE', 'INACTIVE'];
const STATUS_LABEL: Record<string, string> = {
  ACTIVE: '사용',
  INACTIVE: '미사용',
};
const NOT_FOUND = '플랫폼 관리자 계정을 찾을 수 없습니다';
const LOGIN_ID_TAKEN =
  '이미 사용 중인 아이디입니다. 삭제된 계정의 아이디도 다시 쓸 수 없습니다';
const EMAIL_TAKEN = '사용 중이거나 미사용인 다른 관리자 계정의 이메일입니다';
const CHANGED_MEANWHILE =
  '그 사이 다른 관리자가 이 계정을 바꿨습니다. 최신 정보를 불러온 뒤 다시 해 주세요';

const roleGroupSelect = {
  roleGroupId: true,
  roleCode: true,
  name: true,
  roleTypeCode: true,
} as const;
const summarySelect = {
  adminAccountId: true,
  loginId: true,
  name: true,
  roleGroup: { select: roleGroupSelect },
  accountStatusCode: true,
  phone: true,
  email: true,
  lastLoginAt: true,
  createdAt: true,
  isInitialPasswordUnsent: true,
} as const;
/** 수정 · 삭제 · 초기화가 읽는 대상의 칸 — 바뀐 항목을 가르고 이력에 전후 값을 쓴다. */
const targetSelect = {
  adminAccountId: true,
  loginId: true,
  name: true,
  phone: true,
  email: true,
  department: true,
  jobTitle: true,
  zipCode: true,
  address: true,
  addressDetail: true,
  roleTypeCode: true,
  roleGroupId: true,
  roleGroup: { select: roleGroupSelect },
  accountStatusCode: true,
  updatedAt: true,
} as const;

type RoleGroup = { roleCode: string; name: string; roleTypeCode: string };
type History = {
  field: string;
  beforeValue: string | null;
  afterValue: string | null;
};

/**
 * 플랫폼 관리자 관리 (S-YTKWGG 목록 · S-FOJJKB 등록 · S-BRSPGB 상세 · S-CZGHBS 수정 ·
 * S-NLVXWJ 계정 삭제 · S-XKYOND 비밀번호 초기화). 1팀 `admin_accounts` 중 플랫폼 마스터(PM) ·
 * 플랫폼 관리자(PA)만 다룬다.
 *
 * 메뉴 권한과 플랫폼 계정 여부는 컨트롤러의 가드가 먼저 본다. 여기서는 호출자를 id 로 읽어(caller) 그 위에
 * 얹는 두 보호만 판정한다.
 * - 마스터 보호: PM 계정은 PM 만 고치 · 지우 · 초기화하고, PA 는 PM 권한을 줄 수 없다.
 * - 본인 보호: 본인 계정은 기본정보만 고치고, 스스로 지우거나 여기서 초기화하지 않는다.
 * 그리고 사용 중인 PM 이 한 명은 남아야 한다 — 미사용 · 강등 · 삭제를 잠근 채 센다.
 */
@Injectable()
export class PlatformAdminsService {
  private readonly logger = new Logger(PlatformAdminsService.name);

  constructor(
    private readonly prisma: PrismaService,
    /** 비밀번호 메일을 보낼 수단. 메일 설정이 없는 환경이면 null — 보내지 않고 「미발송」으로 둔다. */
    @Inject(PLATFORM_ADMIN_MAIL) private readonly sender: PlatformAdminMail,
    private readonly permissions: MenuPermissionsService,
  ) {}

  async list({
    keyword,
    roleGroupId,
    statuses,
    page,
    pageSize,
  }: ListPlatformAdminsDto): Promise<PlatformAdminListResponseDto> {
    const where: Prisma.AdminAccountWhereInput = {
      roleTypeCode: { in: PLATFORM_ROLE_TYPES },
      bpCode: { isPlatform: true },
      isDeleted: false,
      accountStatusCode: { in: statuses?.length ? statuses : STATUSES },
      ...(roleGroupId && { roleGroupId }),
      ...(keyword && {
        OR: [
          { loginId: { contains: keyword, mode: 'insensitive' } },
          { name: { contains: keyword, mode: 'insensitive' } },
        ],
      }),
    };
    const [rows, total, inactiveCount] = await this.prisma.$transaction([
      this.prisma.adminAccount.findMany({
        where,
        select: summarySelect,
        orderBy: [{ createdAt: 'desc' }, { adminAccountId: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.adminAccount.count({ where }),
      // 「미사용 N」은 상태 조건을 덮어쓴다 — 사용만 골라 봐도 미사용이 몇인지 보인다.
      this.prisma.adminAccount.count({
        where: { ...where, accountStatusCode: 'INACTIVE' },
      }),
    ]);
    return {
      items: rows.map(({ accountStatusCode, ...row }) => ({
        ...row,
        accountStatus: accountStatusCode,
      })),
      total,
      inactiveCount,
    };
  }

  /**
   * 아이디를 쓸 수 있는가. 삭제 · 탈퇴한 계정까지 모든 관리자 계정(BP 쪽 포함)과 겹치면 안 된다(PL-OCJOFP).
   * 등록 화면이 칸을 벗어날 때 미리 묻고, 등록도 같은 판정을 쓴다 — 그 사이 누가 먼저 가져가면 등록이 409 로 막는다.
   */
  async isLoginIdAvailable(
    loginId: string,
    db: Tx | PrismaService = this.prisma,
  ): Promise<boolean> {
    const row = await db.adminAccount.findFirst({
      where: { loginId },
      select: { adminAccountId: true },
    });
    return row === null;
  }

  /** 등록 · 수정 화면의 사용자 권한 선택지. PA 에게는 PM 그룹을 빼고 준다. */
  async roleGroups(
    callerId: number,
  ): Promise<PlatformRoleGroupListResponseDto> {
    const caller = await this.permissions.caller(callerId);
    const items = await this.prisma.roleGroup.findMany({
      where: {
        isDeleted: false,
        roleTypeCode: {
          in: caller.roleTypeCode === MASTER ? PLATFORM_ROLE_TYPES : ['PA'],
        },
        bpCode: { isPlatform: true },
      },
      select: roleGroupSelect,
      orderBy: { roleCode: 'asc' },
    });
    return { items };
  }

  async detail(
    adminAccountId: number,
  ): Promise<PlatformAdminDetailResponseDto> {
    const row = await this.prisma.adminAccount.findFirst({
      where: platformAdmin(adminAccountId),
      select: {
        ...summarySelect,
        department: true,
        jobTitle: true,
        zipCode: true,
        address: true,
        addressDetail: true,
        statusChangedAt: true,
        updatedAt: true,
        creator: { select: { name: true } },
        updater: { select: { name: true } },
      },
    });
    if (!row) throw new NotFoundException(NOT_FOUND);
    const { accountStatusCode, creator, updater, ...rest } = row;
    return {
      ...rest,
      accountStatus: accountStatusCode,
      createdByName: creator?.name ?? null,
      updatedByName: updater?.name ?? null,
    };
  }

  async histories(
    adminAccountId: number,
    { page, pageSize }: PageDto,
  ): Promise<PlatformAdminHistoryListResponseDto> {
    const exists = await this.prisma.adminAccount.findFirst({
      where: platformAdmin(adminAccountId),
      select: { adminAccountId: true },
    });
    if (!exists) throw new NotFoundException(NOT_FOUND);
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
   * 등록. 늘 사용 · 플랫폼등록으로 만들고 쓸 수 있는 비밀번호는 두지 않는다 — 첫 로그인은 메일로만
   * 보낸 1시간짜리 초기 비밀번호로 한다. 「초기 비밀번호 미발송」으로 만들어 두고 메일이 나간 뒤에야
   * 내린다 — 메일이나 그 뒤 쓰기가 실패해도 계정은 남고 미발송으로 보인다(다시 보내는 길은 비밀번호 초기화).
   */
  async create(
    callerId: number,
    raw: CreatePlatformAdminDto,
  ): Promise<CreatePlatformAdminResponseDto> {
    const caller = await this.permissions.caller(callerId);
    // DB 가 소문자만 받는다(CHECK admin_accounts_email_lower). DTO 를 거치지 않은 호출도 맞춘다.
    const input = { ...raw, email: raw.email.toLowerCase() };
    const platformBp = await this.prisma.bpCode.findFirst({
      where: { isPlatform: true },
      select: { bpCodeId: true },
    });
    if (!platformBp) throw new Error('플랫폼 BP 가 없습니다');

    const password = generateTempPassword();
    const passwordHash = await hashPassword(password);
    const by = caller.adminAccountId;
    const { adminAccountId, issuedId } = await this.prisma
      .$transaction(async (tx) => {
        const group = await this.lockPlatformRoleGroup(tx, input.roleGroupId);
        if (group.roleTypeCode === MASTER && caller.roleTypeCode !== MASTER)
          throw new ForbiddenException(
            '플랫폼 마스터 계정을 등록할 권한이 없습니다',
          );
        if (!(await this.isLoginIdAvailable(input.loginId, tx)))
          throw new ConflictException(LOGIN_ID_TAKEN);
        if (await this.findEmailOwner(tx, input.email))
          throw new ConflictException(EMAIL_TAKEN);

        const { adminAccountId: id } = await tx.adminAccount.create({
          data: {
            loginId: input.loginId,
            name: input.name,
            phone: input.phone,
            email: input.email,
            department: input.department ?? null,
            jobTitle: input.jobTitle ?? null,
            zipCode: input.zipCode ?? null,
            address: input.address ?? null,
            addressDetail: input.addressDetail ?? null,
            bpCodeId: platformBp.bpCodeId,
            roleGroupId: input.roleGroupId,
            roleTypeCode: group.roleTypeCode,
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
        const issued = await issueTempPassword(
          tx,
          id,
          passwordHash,
          'INITIAL',
          by,
        );
        await this.record(tx, id, by, [
          {
            field: '계정',
            beforeValue: null,
            afterValue: `${STATUS_LABEL.ACTIVE} · ${roleLabel(group)}`,
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
        throw error;
      });

    const isMailSent = await sendPassword(
      this.sender,
      this.logger,
      adminAccountId,
      by,
      {
        templateCode: 'EMAIL_PLAT_ADMIN_CREATE',
        to: input.email,
        variables: {
          관리자이름: input.name,
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
   * 미사용으로 바꾸면 다음 요청부터 메뉴 권한 판정에서 막히고(사용 중 계정만 통과, 403), 새 로그인은 403,
   * 갱신(refresh)은 401 이다. 세션은 여기서 끊지 않는다 — 가드는 계정 상태를 보지 않으므로 로그인 중인 세션은
   * 갱신에서 끝난다(최대 1시간, admin-auth.md).
   */
  async update(
    callerId: number,
    adminAccountId: number,
    raw: UpdatePlatformAdminDto,
  ): Promise<void> {
    const caller = await this.permissions.caller(callerId);
    const input = { ...raw, email: raw.email.toLowerCase() };
    await this.prisma
      .$transaction(async (tx) => {
        const target = await this.findTarget(tx, adminAccountId);
        this.assertMasterProtection(caller, target.roleTypeCode, '고칠');

        const isSelf = caller.adminAccountId === adminAccountId;
        const isRoleChanged = input.roleGroupId !== target.roleGroupId;
        const isStatusChanged =
          input.accountStatus !== target.accountStatusCode;
        if (isSelf && (isRoleChanged || isStatusChanged))
          throw new ForbiddenException(
            '본인 계정의 권한 · 상태는 바꿀 수 없습니다',
          );

        const group = isRoleChanged
          ? await this.lockPlatformRoleGroup(tx, input.roleGroupId)
          : target.roleGroup;
        if (
          isRoleChanged &&
          group.roleTypeCode === MASTER &&
          caller.roleTypeCode !== MASTER
        )
          throw new ForbiddenException(
            '플랫폼 마스터 권한을 줄 권한이 없습니다',
          );

        if (
          input.email !== target.email &&
          (await this.findEmailOwner(tx, input.email, adminAccountId))
        )
          throw new ConflictException(
            '이미 다른 관리자 계정에 등록된 이메일입니다',
          );

        const leavesMaster =
          input.accountStatus !== 'ACTIVE' || group.roleTypeCode !== MASTER;
        if (
          target.roleTypeCode === MASTER &&
          target.accountStatusCode === 'ACTIVE' &&
          leavesMaster
        )
          await this.assertAnotherActiveMaster(tx, adminAccountId);

        const { count } = await tx.adminAccount.updateMany({
          where: {
            adminAccountId,
            updatedAt: sameMillisecond(input.updatedAt),
          },
          data: {
            name: input.name,
            phone: input.phone,
            email: input.email,
            department: input.department ?? null,
            jobTitle: input.jobTitle ?? null,
            zipCode: input.zipCode ?? null,
            address: input.address ?? null,
            addressDetail: input.addressDetail ?? null,
            roleGroupId: input.roleGroupId,
            roleTypeCode: group.roleTypeCode,
            accountStatusCode: input.accountStatus,
            ...(isStatusChanged && { statusChangedAt: new Date() }),
            updatedBy: caller.adminAccountId,
          },
        });
        if (count === 0)
          throw new ConflictException(
            '다른 관리자가 먼저 수정했습니다. 최신 정보를 불러온 뒤 다시 저장해 주세요',
          );
        // 옛 주소로 나간(또는 나가는 중인) 임시 비밀번호는 옛 주소의 주인이 쓸 수 있다 — 함께 막는다.
        // 등록 · 초기화한 계정은 그것이 유일한 로그인 수단이므로, 막았으면 「미발송」을 다시 켜 초기화하게 한다.
        if (
          input.email !== target.email &&
          (await invalidateTempPasswords(
            tx,
            adminAccountId,
            caller.adminAccountId,
          )) > 0
        )
          await tx.adminAccount.update({
            where: { adminAccountId },
            data: { isInitialPasswordUnsent: true },
          });

        await this.record(tx, adminAccountId, caller.adminAccountId, [
          change('이름', target.name, input.name),
          change('연락처', target.phone, input.phone),
          change('이메일', target.email, input.email),
          change('소속 부서', target.department, input.department ?? null),
          change('직책', target.jobTitle, input.jobTitle ?? null),
          change(
            '주소',
            addressOf(target),
            addressOf({
              zipCode: input.zipCode ?? null,
              address: input.address ?? null,
              addressDetail: input.addressDetail ?? null,
            }),
          ),
          change('사용자 권한', roleLabel(target.roleGroup), roleLabel(group)),
          change(
            '계정 상태',
            STATUS_LABEL[target.accountStatusCode],
            STATUS_LABEL[input.accountStatus],
          ),
        ]);
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw new ConflictException(
            '이미 다른 관리자 계정에 등록된 이메일입니다',
          );
        throw error;
      });
  }

  /**
   * 계정 삭제 — 논리 삭제. 목록 · 검색 · 상세에서 빠지고 다음 요청부터 메뉴 권한 판정에서 막힌다(403).
   * 로그인 · 갱신은 401 이라 로그인 중인 세션도 갱신에서 끝난다. 되살리지 않는다.
   */
  async remove(callerId: number, adminAccountId: number): Promise<void> {
    const caller = await this.permissions.caller(callerId);
    await this.prisma.$transaction(async (tx) => {
      const target = await this.findTarget(tx, adminAccountId);
      if (caller.adminAccountId === adminAccountId)
        throw new ForbiddenException('본인 계정은 스스로 삭제할 수 없습니다');
      this.assertMasterProtection(caller, target.roleTypeCode, '지울');
      if (
        target.roleTypeCode === MASTER &&
        target.accountStatusCode === 'ACTIVE'
      )
        await this.assertAnotherActiveMaster(tx, adminAccountId);

      // 상태까지 본다 — 미사용으로 읽어 마지막 PM 확인을 건너뛴 PM 이 그 사이 사용으로 바뀌었으면,
      // 그대로 지우면 사용 중 PM 이 0명이 될 수 있다.
      const { count } = await tx.adminAccount.updateMany({
        where: {
          ...unchangedTarget(target),
          accountStatusCode: target.accountStatusCode,
        },
        data: { isDeleted: true, updatedBy: caller.adminAccountId },
      });
      if (count === 0) throw new ConflictException(CHANGED_MEANWHILE);
      await this.record(tx, adminAccountId, caller.adminAccountId, [
        {
          field: '계정',
          beforeValue: STATUS_LABEL[target.accountStatusCode] ?? null,
          afterValue: '삭제',
        },
      ]);
    });
  }

  /**
   * 비밀번호 초기화. 기존 비밀번호와 앞서 낸 초기 비밀번호를 바로 막고, 새 1시간짜리 초기
   * 비밀번호를 그 계정 이메일로만 보낸다 — 초기화한 사람도 값을 볼 수 없다. 계정 상태는 그대로다.
   * 강제 변경 표시(isPasswordChangeRequired)가 켜지므로 대상의 모든 세션은 다음 요청부터 가드가 403
   * (비밀번호 변경 안내)을 내고, 다음 갱신(refresh)에서 아주 종료된다(401). 그 전에 새 초기 비밀번호로
   * 다른 곳에서 로그인했다면 갱신은 되지만 변경 전까지 403 은 그대로다. 세션 행을 여기서 끊지는 않는다. 초기화 · 감사 이력 · 「미발송」 표시를 한 트랜잭션으로 쓰고, 메일이
   * 나간 뒤에야 미발송을 내린다. 메일이 실패하면 미발송으로 남아 다시 초기화하게 한다.
   */
  async resetPassword(
    callerId: number,
    adminAccountId: number,
  ): Promise<ResetPasswordResponseDto> {
    const caller = await this.permissions.caller(callerId);
    const target = await this.findTarget(this.prisma, adminAccountId);
    if (caller.adminAccountId === adminAccountId)
      throw new ForbiddenException('본인 비밀번호는 내 정보에서 바꿔 주세요');
    this.assertMasterProtection(caller, target.roleTypeCode, '초기화할');
    if (!target.email)
      throw new ConflictException('이메일이 없는 계정이라 보낼 곳이 없습니다');
    // 초기화는 기존 비밀번호를 지운다. 새 비밀번호를 보낼 길이 없으면 계정이 잠기므로 아무것도 쓰지 않는다
    // (등록은 지울 비밀번호가 없어 「미발송」으로 남긴다).
    if (this.sender === null)
      throw new ServiceUnavailableException(
        '메일 설정이 없어 비밀번호를 초기화할 수 없습니다',
      );

    const by = caller.adminAccountId;
    const password = generateTempPassword();
    const passwordHash = await hashPassword(password);
    const issued = await this.prisma.$transaction(async (tx) => {
      // 읽은 뒤 지워지거나 PM 으로 올라갔으면 위 판정이 낡았다 — 아무것도 내지 않는다.
      // 이메일까지 본다 — 읽은 뒤 바뀌었으면 옛 주소로 비밀번호를 보내게 된다.
      const { count } = await tx.adminAccount.updateMany({
        where: { ...unchangedTarget(target), email: target.email },
        data: {
          passwordHash: LOCKED_PASSWORD,
          isPasswordChangeRequired: true,
          isInitialPasswordUnsent: true,
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
      // 누가 비밀번호를 초기화했는지는 5년 보존 감사 기록이다 — 커밋 뒤가 아니라 함께 쓴다.
      // 메일 결과는 미발송 표시와 mail_send_logs 가 담는다.
      await this.record(tx, adminAccountId, by, [
        { field: '초기 비밀번호', beforeValue: null, afterValue: '초기화' },
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
        to: target.email,
        variables: {
          관리자이름: target.name ?? target.loginId,
          임시비밀번호: password,
        },
      },
    );
    // 초기화가 updatedAt 을 올렸다. 화면이 들고 있던 값으로 저장하면 거짓 409 가 나므로 새 값을 돌려준다.
    // 미발송을 내리지 못했거나(실패 · 그 사이 다른 초기화) 내릴 일이 없으면 쓰인 것이 없으니 트랜잭션 때 값이 맞다.
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
          // 내리기 직전 값이 초기화 때 값과 같을 때만 새 값을 준다. 다르면 그 사이 다른 관리자가 저장한 것이다 —
          // 새 값을 주면 화면이 그 수정 전 값으로 409 없이 덮어쓰므로, 옛 값을 줘 다음 저장이 409 가 나게 한다.
          if (sent && sent.before.getTime() === updatedAt.getTime())
            updatedAt = sent.after;
        },
      );
    return { isMailSent, updatedAt };
  }

  private async findTarget(db: Tx | PrismaService, adminAccountId: number) {
    const target = await db.adminAccount.findFirst({
      where: platformAdmin(adminAccountId),
      select: targetSelect,
    });
    if (!target) throw new NotFoundException(NOT_FOUND);
    return target;
  }

  /**
   * 줄 수 있는 권한 그룹 — 플랫폼 BP 의 지우지 않은 PM · PA 그룹. 아니면 400.
   * 그룹 행을 FOR SHARE 로 잠근 뒤 읽는다. 권한 그룹 삭제의 FOR UPDATE 와 서로 기다리므로, 삭제가 먼저면 그 커밋 뒤에
   * 다음 문장이 지운 그룹을 보고 400 이고, 이쪽이 먼저면 삭제가 이 커밋을 기다렸다가 붙은 관리자까지 읽는다(대체 권한을
   * 골랐으면 옮기고, 아니면 삭제가 400). 관리자 행보다 먼저 잠근다 — 삭제도 그룹을 잠근 뒤 관리자 행을 잠근다.
   * 떠나는 그룹은 잠그지 않는다 — 그 그룹의 삭제는 관리자 행을 FOR UPDATE 로 읽으므로 이 수정을 기다렸다가 뺀다.
   */
  private async lockPlatformRoleGroup(tx: Tx, roleGroupId: number) {
    await tx.$queryRaw`
      SELECT role_group_id FROM role_groups
       WHERE role_group_id = ${roleGroupId}
         FOR SHARE`;
    const group = await tx.roleGroup.findFirst({
      where: {
        roleGroupId,
        isDeleted: false,
        roleTypeCode: { in: PLATFORM_ROLE_TYPES },
        bpCode: { isPlatform: true },
      },
      select: roleGroupSelect,
    });
    if (!group)
      throw new BadRequestException(
        '플랫폼 관리자에게 줄 수 있는 권한이 아닙니다',
      );
    return group;
  }

  /** 이메일은 지우지 않은 사용 · 미사용 계정끼리 고유하다(부분 고유 인덱스 admin_accounts_email_key). */
  private findEmailOwner(
    db: Tx | PrismaService,
    email: string,
    exceptAdminAccountId?: number,
  ) {
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

  private assertMasterProtection(
    caller: MenuCaller,
    targetRoleType: string,
    verb: string,
  ): void {
    if (targetRoleType === MASTER && caller.roleTypeCode !== MASTER)
      throw new ForbiddenException(
        `플랫폼 마스터 계정은 플랫폼 마스터만 ${verb} 수 있습니다`,
      );
  }

  /**
   * 사용 중인 PM 을 잠그고 대상 말고 한 명이 더 있는지 센다. 둘이 서로를 동시에 내리려 해도
   * 잠금 순서대로 하나씩 들어오고, 늦은 쪽은 먼저 내려간 행을 WHERE 로 다시 거르므로 0명이 되지 않는다.
   * FOR UPDATE 가 아니라 FOR NO KEY UPDATE 다 — 다른 요청이 PM 을 수정자로 쓰는 갱신은 외래키
   * (updated_by → admin_accounts)를 확인하며 그 PM 행에 FOR KEY SHARE 를 거는데, FOR UPDATE 는 그와
   * 충돌해 교착(40P01 → 500)할 수 있다. 이 확인끼리는 여전히 서로를 기다린다.
   * 플랫폼 BP 소속 PM 만 센다 — 고객 BP 소속 PM 은 이 화면을 쓰지 못해 마스터 노릇을 하지 못한다.
   * bp_codes 는 WHERE 의 부분 질의로만 읽어 잠그지 않는다.
   */
  private async assertAnotherActiveMaster(
    tx: Tx,
    adminAccountId: number,
  ): Promise<void> {
    const masters = await tx.$queryRaw<{ admin_account_id: number }[]>`
      SELECT admin_account_id FROM admin_accounts
       WHERE role_type_code = 'PM' AND is_deleted = false AND account_status_code = 'ACTIVE'
         AND bp_code_id IN (SELECT bp_code_id FROM bp_codes WHERE is_platform)
       ORDER BY admin_account_id
         FOR NO KEY UPDATE`;
    if (!masters.some((m) => m.admin_account_id !== adminAccountId))
      throw new ConflictException(
        '사용 중인 플랫폼 마스터가 한 명은 있어야 합니다',
      );
  }

  /** 바뀐 항목만 이력으로 남긴다. 비밀번호 값은 쓰지 않는다. */
  private async record(
    db: Tx | PrismaService,
    adminAccountId: number,
    changedBy: number,
    changes: (History | null)[],
  ): Promise<void> {
    const data = changes
      .filter((c): c is History => c !== null)
      .map((c) => ({ adminAccountId, ...c, changedBy }));
    if (data.length) await db.adminChangeHistory.createMany({ data });
  }
}

/**
 * 이 화면이 다루는 계정 — 플랫폼 BP 소속의 지우지 않은 PM · PA. 고객 BP 소속인데 PM · PA 인 계정은
 * 잘못 붙은 역할이라 플랫폼 계정으로 보지 않는다(목록과 같다).
 */
function platformAdmin(adminAccountId: number): Prisma.AdminAccountWhereInput {
  return {
    adminAccountId,
    isDeleted: false,
    roleTypeCode: { in: PLATFORM_ROLE_TYPES },
    bpCode: { isPlatform: true },
    // 탈퇴는 이 화면이 다루지 않는다 — 수정이 「사용」으로 되살리거나 이력에 없는 상태를 쓰지 않게 뺀다.
    accountStatusCode: { not: 'WITHDRAWN' },
  };
}

/** 읽은 그대로인 대상 — 그 사이 지워지거나 권한 유형이 바뀌었으면 맞지 않는다(마스터 보호 판정이 낡는다). */
function unchangedTarget(target: {
  adminAccountId: number;
  roleTypeCode: string;
}): Prisma.AdminAccountWhereInput {
  return {
    adminAccountId: target.adminAccountId,
    isDeleted: false,
    roleTypeCode: target.roleTypeCode,
  };
}

/**
 * 화면이 받아 간 updatedAt(ms)과 같은 ms 안에 있는가. DB 는 µs 까지 저장한다 — SQL 기본값으로 들어간 행
 * (초기 데이터의 whaleadmin 등)은 µs 가 남아 등호로는 영원히 같지 않아, 저장할 때마다 동시 수정 409 가 난다.
 */
function sameMillisecond(iso: string): Prisma.DateTimeFilter {
  const at = new Date(iso);
  return { gte: at, lt: new Date(at.getTime() + 1) };
}

function roleLabel(group: RoleGroup): string {
  return `${group.name} ${group.roleCode}`;
}

function addressOf(a: {
  zipCode: string | null;
  address: string | null;
  addressDetail: string | null;
}): string | null {
  const text = [a.zipCode && `(${a.zipCode})`, a.address, a.addressDetail]
    .filter(Boolean)
    .join(' ');
  return text || null;
}

function change(
  field: string,
  beforeValue: string | null,
  afterValue: string | null,
): History | null {
  return beforeValue === afterValue ? null : { field, beforeValue, afterValue };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
