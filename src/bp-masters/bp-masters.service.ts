import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  BusinessVerificationService,
  DUPLICATE_BIZ_REGISTRATION_NUMBER,
} from '../admin-signup/business-verification.service';
import { nextBpCode } from '../admin-signup/next-bp-code';
import type { BpBusinessVerificationDto } from '../auth/dto/bp-business-verification.dto';
import { hashPassword } from '../auth/password';
import {
  copyProvidedItems,
  providedOriginals,
} from '../code-groups/provided-code-copy';
import {
  afterCommit,
  invalidateTempPasswords,
  issueTempPassword,
  LOCKED_PASSWORD,
  markSent,
  sendPassword,
} from '../platform-admins/admin-password';
import {
  PLATFORM_ADMIN_MAIL,
  type PlatformAdminMail,
} from '../platform-admins/platform-admin-mail';
import { generateTempPassword } from '../platform-admins/temp-password';
import { PrismaService } from '../prisma/prisma.service';
import {
  STORE_EXCEL_INTERVAL_MS,
  STORE_EXCEL_MAX_ROWS,
} from '../stores/store-excel';
import {
  bpMasterExcelFileName,
  buildBpMasterWorkbook,
} from './bp-master-excel';
import type { ChangeableBpStatus } from './dto/bp-master-status.dto';
import type {
  BpMasterBusinessVerificationResponseDto,
  BpMasterDetailResponseDto,
  BpMasterHistoryListResponseDto,
  BpMasterListResponseDto,
  BpMasterSummaryResponseDto,
  CreateBpMasterResponseDto,
  ResetBpMasterPasswordResponseDto,
} from './dto/bp-master.response.dto';
import type {
  BpMasterFilterDto,
  ListBpMastersDto,
} from './dto/list-bp-masters.dto';
import type {
  CreateBpMasterDto,
  UpdateBpMasterDto,
} from './dto/save-bp-master.dto';

type Tx = Prisma.TransactionClient;

const BP_MASTER = 'BM';
const BP_MASTER_ROLE_CODE = 'BM000001';
/** 하위 관리자 — BP 관리자 · 가맹 마스터 · 가맹 관리자 */
const SUB_ROLE_TYPES = ['BA', 'FM', 'FA'];
const WITHDRAWN = 'WITHDRAWN';
const STATUS_LABEL: Record<string, string> = {
  ACTIVE: '사용',
  INACTIVE: '미사용',
  WITHDRAWN: '탈퇴',
};
const NOT_FOUND = 'BP를 찾을 수 없습니다';
const WITHDRAWN_BP = '탈퇴한 BP는 바꿀 수 없습니다';
const CHANGED_MEANWHILE =
  '그 사이 다른 관리자가 이 BP를 바꿨습니다. 최신 정보를 불러온 뒤 다시 해 주세요';
const LOGIN_ID_TAKEN =
  '이미 사용 중인 아이디입니다. 삭제 · 탈퇴한 계정의 아이디도 다시 쓸 수 없습니다';
const EMAIL_TAKEN = '사용 중이거나 미사용인 다른 관리자 계정의 이메일입니다';
// 국세청 키 · 하루 할당량은 가입 · 점포 · MY PAGE 와 함께 쓴다 — 같은 한도를 관리자별로 센다(BpProfileService 와 같다).
const NTS_CALLS_PER_HOUR = 10;
const NTS_WINDOW_MS = 3_600_000;

const masterSelect = {
  adminAccountId: true,
  loginId: true,
  name: true,
  phone: true,
  email: true,
  joinPathCode: true,
  accountStatusCode: true,
  statusChangedAt: true,
  lastLoginAt: true,
  termsAgreedAt: true,
  isPasswordChangeRequired: true,
  isInitialPasswordUnsent: true,
} as const;
/** 이 BP 의 BP 마스터 — BP 하나에 하나다. */
const masterOnly = { roleTypeCode: BP_MASTER, isDeleted: false };
const bpSelect = {
  bpCodeId: true,
  bpCode: true,
  accountStatusCode: true,
  tradeName: true,
  bizRegistrationNumber: true,
  bizCeoName: true,
  bizOpenDate: true,
  bizCeoPhone: true,
  bizCeoEmail: true,
  bizZipCode: true,
  bizAddress: true,
  bizAddressDetail: true,
  bizCategory: true,
  bizItem: true,
  bizVerifiedAt: true,
  createdAt: true,
  updatedAt: true,
  creator: { select: { name: true } },
  updater: { select: { name: true } },
  adminAccounts: {
    where: masterOnly,
    select: masterSelect,
    orderBy: { adminAccountId: 'asc' },
    take: 1,
  },
} as const;
const ORDER_BY: Prisma.BpCodeOrderByWithRelationInput[] = [
  { createdAt: 'desc' },
  { bpCodeId: 'desc' },
];

type BpRow = Prisma.BpCodeGetPayload<{ select: typeof bpSelect }>;
type MasterRow = BpRow['adminAccounts'][number];
type History = {
  field: string;
  beforeValue: string | null;
  afterValue: string | null;
};
type HistoryRow = {
  changed_at: Date;
  field: string;
  before_value: string | null;
  after_value: string | null;
  changed_by_name: string | null;
  note: string | null;
};

/**
 * BP 마스터 계정 관리(메뉴 MN000203, BP-1~5). 플랫폼이 고객 BP 와 그 BP 마스터(BM) 계정을 함께 다룬다 —
 * BP 하나에 BP 마스터 하나다. 플랫폼 BP(BP000000)와 지운 BP 는 다루지 않는다. 탈퇴한 BP 는 보기만 한다.
 *
 * 메뉴 권한과 플랫폼 계정 여부는 컨트롤러의 가드가 본다. 이력은 둘로 나뉜다 — BP 의 칸 · 상태는
 * bp_change_histories, BP 마스터 계정의 칸은 admin_change_histories. 상세의 변경 이력은 둘을 합쳐 보인다.
 * 비밀번호 초기화는 이력에 넣지 않는다(mail_send_logs 와 temporary_passwords 가 남긴다).
 */
@Injectable()
export class BpMastersService {
  private readonly logger = new Logger(BpMastersService.name);
  /** 관리자별 엑셀 받은 시각(ms). 프로세스 메모리라 인스턴스마다 따로 센다(점포 엑셀과 같다). */
  private readonly excelAt = new Map<number, number>();
  /** 관리자별 국세청 호출 시각(ms). */
  private readonly ntsCallsAt = new Map<number, number[]>();

  constructor(
    private readonly prisma: PrismaService,
    /** 비밀번호 메일을 보낼 수단. 메일 설정이 없는 환경이면 null. */
    @Inject(PLATFORM_ADMIN_MAIL) private readonly sender: PlatformAdminMail,
    private readonly verifications: BusinessVerificationService,
  ) {}

  async list({
    page,
    pageSize,
    ...filter
  }: ListBpMastersDto): Promise<BpMasterListResponseDto> {
    const where = listWhere(filter);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.bpCode.findMany({
        where,
        select: bpSelect,
        orderBy: ORDER_BY,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.bpCode.count({ where }),
    ]);
    return {
      items: rows.flatMap((row) => {
        const master = row.adminAccounts[0];
        return master ? [summaryOf(row, master)] : [];
      }),
      total,
    };
  }

  async detail(bpCodeId: number): Promise<BpMasterDetailResponseDto> {
    const { bp, master } = await this.findBp(this.prisma, bpCodeId);
    const [storeCount, subAdminCount, deletion] = await Promise.all([
      this.prisma.store.count({
        where: {
          bpCodeId,
          isDeleted: false,
          storeStatusCode: { not: 'CLOSED' },
        },
      }),
      this.countSubAdmins(this.prisma, bpCodeId),
      this.deletionReasons(this.prisma, bp, master),
    ]);
    return {
      ...summaryOf(bp, master),
      adminAccountId: master.adminAccountId,
      statusChangedAt: master.statusChangedAt,
      bizCeoName: bp.bizCeoName,
      bizOpenDate: dateOnly(bp.bizOpenDate),
      ...ceoContactOf(bp),
      bizZipCode: bp.bizZipCode,
      bizAddress: bp.bizAddress,
      bizAddressDetail: bp.bizAddressDetail,
      bizCategory: bp.bizCategory,
      bizItem: bp.bizItem,
      bizVerifiedAt: bp.bizVerifiedAt,
      storeCount,
      subAdminCount,
      lastLoginAt: master.lastLoginAt,
      termsAgreedAt: master.termsAgreedAt,
      isPasswordChangeRequired: master.isPasswordChangeRequired,
      isInitialPasswordUnsent: master.isInitialPasswordUnsent,
      updatedAt: bp.updatedAt,
      updatedByName: bp.updater?.name ?? null,
      deletion: { isDeletable: deletion.length === 0, reasons: deletion },
    };
  }

  /**
   * BP 이력과 그 BP 마스터 계정 이력을 합쳐 최신순으로. 두 표를 SQL 의 UNION ALL 로 합쳐야 쪽을 나눌 수 있다 —
   * 따로 읽어 합치면 뒤쪽 페이지마다 앞의 행을 모두 읽어야 한다.
   */
  async histories(
    bpCodeId: number,
    { page, pageSize }: { page: number; pageSize: number },
  ): Promise<BpMasterHistoryListResponseDto> {
    const { master } = await this.findBp(this.prisma, bpCodeId);
    const adminAccountId = master.adminAccountId;
    const [rows, bpTotal, accountTotal] = await Promise.all([
      this.prisma.$queryRaw<HistoryRow[]>`
        SELECT h.changed_at, h.field, h.before_value, h.after_value, h.note,
               a.name AS changed_by_name
          FROM (SELECT 1 AS source, change_id, changed_at, field, before_value, after_value,
                       changed_by, note
                  FROM bp_change_histories WHERE bp_code_id = ${bpCodeId}
                UNION ALL
                SELECT 0, change_id, changed_at, field, before_value, after_value,
                       changed_by, NULL
                  FROM admin_change_histories WHERE admin_account_id = ${adminAccountId}) h
          LEFT JOIN admin_accounts a ON a.admin_account_id = h.changed_by
         ORDER BY h.changed_at DESC, h.source DESC, h.change_id DESC
         LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      this.prisma.bpChangeHistory.count({ where: { bpCodeId } }),
      this.prisma.adminChangeHistory.count({ where: { adminAccountId } }),
    ]);
    return {
      items: rows.map((r) => ({
        changedAt: r.changed_at,
        field: r.field,
        beforeValue: r.before_value,
        afterValue: r.after_value,
        changedByName: r.changed_by_name,
        note: r.note,
      })),
      total: bpTotal + accountTotal,
    };
  }

  /**
   * 아이디를 쓸 수 있는가. 삭제 · 탈퇴한 계정까지 모든 관리자 계정과 겹치면 안 되고(PL-OCJOFP), 대소문자는
   * 가리지 않는다 — 고유 인덱스는 대소문자를 가리므로 이 확인이 유일한 방어다(회원가입과 같다).
   */
  async isLoginIdAvailable(loginId: string): Promise<boolean> {
    const row = await this.prisma.adminAccount.findFirst({
      where: { loginId: { equals: loginId, mode: 'insensitive' } },
      select: { adminAccountId: true },
    });
    return row === null;
  }

  /** 이메일 중복 확인. 저장 409(EMAIL_TAKEN)와 같은 규칙이다. */
  async isEmailAvailable(email: string): Promise<boolean> {
    return (await this.findEmailOwner(this.prisma, email)) === null;
  }

  /**
   * 사업자 진위확인 — 검사만 하고 10분짜리 토큰을 준다. 저장은 등록 · 수정이 토큰을 실어야 된다. 수정 화면은
   * bpCodeId 를 보내 자기 BP 가 쓰는 번호(와 그 BP 점포의 번호)를 중복으로 보지 않게 한다.
   */
  async verifyBusiness(
    callerId: number,
    {
      bpCodeId,
      ...identity
    }: BpBusinessVerificationDto & { bpCodeId?: number },
  ): Promise<BpMasterBusinessVerificationResponseDto> {
    if (bpCodeId !== undefined) {
      const { bp } = await this.findBp(this.prisma, bpCodeId);
      assertNotWithdrawn(bp);
    }
    this.countNtsCall(callerId);
    return {
      verificationToken: await this.verifications.verify(identity, bpCodeId),
    };
  }

  /**
   * 등록. BP 와 BP 마스터 계정을 한 트랜잭션에서 만든다 — 늘 사용 · 플랫폼등록, 약관은 첫 로그인 때 동의한다.
   * 쓸 수 있는 비밀번호는 두지 않고 1시간짜리 초기 비밀번호를 메일로만 보낸다. 「초기 비밀번호 미발송」으로
   * 만들어 두고 메일이 나간 뒤에야 내린다(플랫폼 관리자 등록과 같다). 회원가입처럼 플랫폼제공 공통코드를 새
   * BP 로 복사한다.
   */
  async create(
    callerId: number,
    raw: CreateBpMasterDto,
  ): Promise<CreateBpMasterResponseDto> {
    // DTO 가 이미 바꿔 오지만 서비스가 직접 불려도 같게 — 대문자 이메일은 CHECK admin_accounts_email_lower 에 걸린다.
    const input = {
      ...raw,
      loginId: raw.loginId.trim().toLowerCase(),
      email: raw.email.trim().toLowerCase(),
    };
    if (!(await this.isLoginIdAvailable(input.loginId)))
      throw new ConflictException(LOGIN_ID_TAKEN);
    if (await this.findEmailOwner(this.prisma, input.email))
      throw new ConflictException(EMAIL_TAKEN);
    // 화면이 보낸 사업자정보는 받지 않는다 — 진위확인을 통과한 값만 토큰에 들어 있다.
    const biz = input.verificationToken
      ? await this.verifications.readToken(input.verificationToken)
      : null;
    const roleGroup = await this.prisma.roleGroup.findFirst({
      where: { roleCode: BP_MASTER_ROLE_CODE, isDeleted: false },
      select: { roleGroupId: true },
    });
    if (!roleGroup)
      throw new Error(`권한 그룹 ${BP_MASTER_ROLE_CODE} 이(가) 없습니다`);

    const password = generateTempPassword();
    const passwordHash = await hashPassword(password);
    const by = callerId;
    const created = await this.prisma
      .$transaction(async (tx) => {
        const bpCode = await nextBpCode(tx);
        if (biz) await this.assertNumberFree(tx, biz.bizRegistrationNumber);
        const { bpCodeId } = await tx.bpCode.create({
          data: {
            bpCode,
            isPlatform: false,
            accountStatusCode: 'ACTIVE',
            tradeName: input.tradeName,
            ...bizProfileOf(input),
            ...(biz && verifiedBizOf(biz)),
            createdBy: by,
            updatedBy: by,
          },
          select: { bpCodeId: true },
        });
        const { adminAccountId } = await tx.adminAccount.create({
          data: {
            loginId: input.loginId,
            bpCodeId,
            name: input.name,
            phone: input.phone,
            email: input.email,
            roleTypeCode: BP_MASTER,
            roleGroupId: roleGroup.roleGroupId,
            passwordHash: LOCKED_PASSWORD,
            isPasswordChangeRequired: true,
            isInitialPasswordUnsent: true,
            joinPathCode: 'PLATFORM_REGISTERED',
            // BP 마스터는 늘 BP 전체 범위다(회원가입과 같다).
            isAllStores: true,
            accountStatusCode: 'ACTIVE',
            createdBy: by,
            updatedBy: by,
          },
          select: { adminAccountId: true },
        });
        await copyProvidedItems(tx, await providedOriginals(tx), [bpCode], by);
        const issuedId = await issueTempPassword(
          tx,
          adminAccountId,
          passwordHash,
          'INITIAL',
          by,
        );
        await recordBp(tx, bpCodeId, by, [
          { field: 'BP', beforeValue: null, afterValue: '등록' },
        ]);
        return { bpCodeId, bpCode, adminAccountId, issuedId };
      })
      .catch((error: unknown) => {
        // 확인과 INSERT 사이에 같은 아이디 · 이메일 · 사업자등록번호가 먼저 들어갔다.
        if (isUniqueViolation(error))
          throw new ConflictException(
            '이미 사용 중인 아이디 · 이메일 또는 사업자등록번호입니다',
          );
        throw error;
      });

    const { adminAccountId, issuedId } = created;
    const isMailSent = await sendPassword(
      this.sender,
      this.logger,
      adminAccountId,
      by,
      {
        templateCode: 'EMAIL_BP_REGISTER',
        to: input.email,
        variables: {
          BP이름: input.tradeName,
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
    return {
      bpCodeId: created.bpCodeId,
      bpCode: created.bpCode,
      email: input.email,
      isMailSent,
    };
  }

  /**
   * 수정. 동시 수정은 막지 않는다 — 마지막 저장이 남는다(S-CQGGZS). 계정 칸만 바뀌어도 BP 의 최종수정을 올린다 —
   * 상세의 「최종수정」은 BP 와 BP 마스터 계정을 함께 가리킨다. 이메일을 바꾸면 옛 주소로 나간 임시 비밀번호를
   * 막는다 — 옛 주소의 주인이 쓸 수 있다(플랫폼 관리자 수정과 같다).
   */
  async update(
    callerId: number,
    bpCodeId: number,
    raw: UpdateBpMasterDto,
  ): Promise<void> {
    const input = { ...raw, email: raw.email.trim().toLowerCase() };
    const biz = input.verificationToken
      ? await this.verifications.readToken(input.verificationToken)
      : null;
    const by = callerId;
    await this.prisma
      .$transaction(async (tx) => {
        const { bp, master } = await this.findBp(tx, bpCodeId);
        assertNotWithdrawn(bp);
        const adminAccountId = master.adminAccountId;
        if (
          input.email !== master.email &&
          (await this.findEmailOwner(tx, input.email, adminAccountId))
        )
          throw new ConflictException(
            '이미 다른 관리자 계정에 등록된 이메일입니다',
          );
        if (biz)
          await this.assertNumberFree(tx, biz.bizRegistrationNumber, bpCodeId);

        const profile = { tradeName: input.tradeName, ...bizProfileOf(input) };
        await tx.bpCode.update({
          where: { bpCodeId },
          data: { ...profile, ...(biz && verifiedBizOf(biz)), updatedBy: by },
        });
        await tx.adminAccount.update({
          where: { adminAccountId },
          data: {
            name: input.name,
            phone: input.phone,
            email: input.email,
            updatedBy: by,
          },
        });
        if (
          input.email !== master.email &&
          (await invalidateTempPasswords(tx, adminAccountId, by)) > 0
        )
          await tx.adminAccount.update({
            where: { adminAccountId },
            data: { isInitialPasswordUnsent: true },
          });

        await recordAccount(tx, adminAccountId, by, [
          change('이름', master.name, input.name),
          change('연락처', master.phone, input.phone),
          change('이메일', master.email, input.email),
        ]);
        const verified = biz
          ? [
              change(
                '사업자등록번호',
                bp.bizRegistrationNumber,
                biz.bizRegistrationNumber,
              ),
              change('대표자명', bp.bizCeoName, biz.bizCeoName),
              change('개업일자', dateOnly(bp.bizOpenDate), biz.bizOpenDate),
            ]
          : [];
        await recordBp(
          tx,
          bpCodeId,
          by,
          [
            change('상호명', bp.tradeName, profile.tradeName),
            change('대표자 연락처', bp.bizCeoPhone, profile.bizCeoPhone),
            change('대표자 이메일', bp.bizCeoEmail, profile.bizCeoEmail),
            change('사업장 우편번호', bp.bizZipCode, profile.bizZipCode),
            change('사업장 기본주소', bp.bizAddress, profile.bizAddress),
            change(
              '사업장 상세주소',
              bp.bizAddressDetail,
              profile.bizAddressDetail,
            ),
            change('업태', bp.bizCategory, profile.bizCategory),
            change('종목', bp.bizItem, profile.bizItem),
          ],
          verified,
        );
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw new ConflictException(
            '이미 사용 중인 이메일 또는 사업자등록번호입니다',
          );
        throw error;
      });
  }

  /**
   * 상태 변경. 미사용이면 BP 와 그 BP 의 사용 중 관리자 계정(BM · BA · FM · FA) 전부를 함께 내린다 — 다음 요청부터
   * 메뉴 권한 판정이 막는다. 세션 · 비밀번호는 그대로다. 사용이면 BP 와 BP 마스터만 올린다 — 하위 계정은 BP
   * 마스터가 하나씩 다시 켠다. 선행 조건은 없다. 이미 그 상태면 아무것도 쓰지 않는다.
   */
  async changeStatus(
    callerId: number,
    bpCodeId: number,
    status: ChangeableBpStatus,
  ): Promise<void> {
    const by = callerId;
    await this.prisma.$transaction(async (tx) => {
      const { bp, master } = await this.findBp(tx, bpCodeId);
      assertNotWithdrawn(bp);
      if (bp.accountStatusCode === status) return;

      // 읽은 상태 그대로일 때만 바꾼다 — 그 사이 다른 관리자가 바꿨으면 이력의 전 값이 틀린다.
      const { count } = await tx.bpCode.updateMany({
        where: { bpCodeId, accountStatusCode: bp.accountStatusCode },
        data: { accountStatusCode: status, updatedBy: by },
      });
      if (count === 0) throw new ConflictException(CHANGED_MEANWHILE);

      const accounts =
        status === 'INACTIVE'
          ? await tx.adminAccount.findMany({
              where: {
                bpCodeId,
                isDeleted: false,
                accountStatusCode: 'ACTIVE',
              },
              select: { adminAccountId: true, roleTypeCode: true },
              orderBy: { adminAccountId: 'asc' },
            })
          : [
              {
                adminAccountId: master.adminAccountId,
                roleTypeCode: BP_MASTER,
              },
            ];
      if (accounts.length)
        await tx.adminAccount.updateMany({
          where: {
            adminAccountId: { in: accounts.map((a) => a.adminAccountId) },
          },
          data: {
            accountStatusCode: status,
            statusChangedAt: new Date(),
            updatedBy: by,
          },
        });

      const from = STATUS_LABEL[bp.accountStatusCode];
      const to = STATUS_LABEL[status];
      await recordBp(tx, bpCodeId, by, [
        { field: 'BP 상태', beforeValue: from, afterValue: to },
      ]);
      // BP 마스터의 상태는 BP 상태와 늘 같아 BP 이력 한 줄로 보인다 — 하위 계정만 계정 이력에 남긴다.
      const subs = accounts.filter((a) => a.roleTypeCode !== BP_MASTER);
      if (subs.length)
        await tx.adminChangeHistory.createMany({
          data: subs.map((a) => ({
            adminAccountId: a.adminAccountId,
            field: '계정 상태',
            beforeValue: from,
            afterValue: to,
            changedBy: by,
          })),
        });
    });
  }

  /**
   * 비밀번호 초기화. 기존 비밀번호와 앞서 낸 초기 비밀번호를 바로 막고, 새 1시간짜리를 BP 마스터 이메일로만
   * 보낸다. 세션은 끊지 않는다 — 강제 변경 표시가 켜져 다음 요청부터 가드가 막는다. 새 비밀번호를 보낼 길이
   * 없으면(메일 설정 없음) 계정이 잠기므로 아무것도 쓰지 않고 503 이다(플랫폼 관리자 초기화와 같다).
   */
  async resetPassword(
    callerId: number,
    bpCodeId: number,
  ): Promise<ResetBpMasterPasswordResponseDto> {
    const { bp, master } = await this.findBp(this.prisma, bpCodeId);
    assertNotWithdrawn(bp);
    if (!master.email)
      throw new ConflictException('이메일이 없는 계정이라 보낼 곳이 없습니다');
    if (this.sender === null)
      throw new ServiceUnavailableException(
        '메일 설정이 없어 비밀번호를 초기화할 수 없습니다',
      );

    const by = callerId;
    const adminAccountId = master.adminAccountId;
    const password = generateTempPassword();
    const passwordHash = await hashPassword(password);
    const issuedId = await this.prisma.$transaction(async (tx) => {
      // 이메일까지 본다 — 읽은 뒤 바뀌었으면 옛 주소로 비밀번호를 보내게 된다.
      const { count } = await tx.adminAccount.updateMany({
        where: { adminAccountId, isDeleted: false, email: master.email },
        data: {
          passwordHash: LOCKED_PASSWORD,
          isPasswordChangeRequired: true,
          isInitialPasswordUnsent: true,
          updatedBy: by,
        },
      });
      if (count === 0) throw new ConflictException(CHANGED_MEANWHILE);
      return issueTempPassword(tx, adminAccountId, passwordHash, 'RESET', by);
    });

    const isMailSent = await sendPassword(
      this.sender,
      this.logger,
      adminAccountId,
      by,
      {
        templateCode: 'EMAIL_PASSWORD_RESET',
        to: master.email,
        variables: {
          관리자이름: master.name ?? master.loginId,
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
    return { isMailSent };
  }

  /**
   * 삭제 — 오등록 BP 를 지운다(논리 삭제). 상세가 보인 조건을 트랜잭션 안에서 다시 본다. BP 와 BP 마스터를 함께
   * 지우고, 아이디는 남겨 다시 쓰지 못하게 한다. 되살리지 않는다.
   */
  async remove(callerId: number, bpCodeId: number): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // 점포 등록 · 하위 계정 생성과 줄을 세우려 BP 행을 잠근다 — 그들은 bp_code_id 외래키로 이 행을 확인한다.
      await tx.$queryRaw`
        SELECT 1 FROM bp_codes WHERE bp_code_id = ${bpCodeId} FOR UPDATE`;
      const { bp, master } = await this.findBp(tx, bpCodeId);
      const reasons = await this.deletionReasons(tx, bp, master);
      if (reasons.length) throw new ConflictException(reasons.join(' '));

      await tx.bpCode.update({
        where: { bpCodeId },
        data: { isDeleted: true, updatedBy: callerId },
      });
      await tx.adminAccount.updateMany({
        where: { bpCodeId, ...masterOnly },
        data: { isDeleted: true, updatedBy: callerId },
      });
      await recordBp(tx, bpCodeId, callerId, [
        {
          field: 'BP',
          beforeValue: STATUS_LABEL[bp.accountStatusCode] ?? null,
          afterValue: '삭제',
        },
      ]);
    });
  }

  /**
   * 엑셀 바로 받기. 목록과 같은 조건 · 순서로 전부 담는다. 1만 건 이상은 아직 받지 않는다(400). 한 사람 1분에
   * 한 번이다(429) — 점포 엑셀과 같은 규칙이고, 받은 기록은 남기지 않는다(점포와 같다, 2026-10-23 결정).
   */
  async excel(
    callerId: number,
    filter: BpMasterFilterDto,
  ): Promise<{ fileName: string; buffer: Buffer }> {
    const now = Date.now();
    const last = this.excelAt.get(callerId);
    if (last !== undefined && now - last < STORE_EXCEL_INTERVAL_MS)
      throw new HttpException(
        `엑셀은 1분에 한 번 받을 수 있습니다. ${Math.ceil((last + STORE_EXCEL_INTERVAL_MS - now) / 1000)}초 뒤 다시 받아 주세요`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    // 파일을 만들기 전에 적어 둔다 — 두 번 누른 요청 중 하나만 지나가게.
    this.excelAt.set(callerId, now);
    for (const [admin, at] of this.excelAt)
      if (now - at >= STORE_EXCEL_INTERVAL_MS) this.excelAt.delete(admin);
    try {
      return await this.buildExcel(filter);
    } catch (error) {
      // 조건을 고치면 되는 거절(4xx)은 1분에 세지 않는다. 서버 오류는 센다 — 다시 눌러 거듭 읽지 않게.
      if (error instanceof HttpException && error.getStatus() < 500)
        this.excelAt.delete(callerId);
      throw error;
    }
  }

  private async buildExcel(
    filter: BpMasterFilterDto,
  ): Promise<{ fileName: string; buffer: Buffer }> {
    const where = listWhere(filter);
    const total = await this.prisma.bpCode.count({ where });
    if (total >= STORE_EXCEL_MAX_ROWS)
      throw new BadRequestException(
        `1만 건 이상은 바로 받을 수 없습니다(${total.toLocaleString('ko-KR')}건). 검색 조건을 좁혀 주세요`,
      );
    const rows = await this.prisma.bpCode.findMany({
      where,
      select: bpSelect,
      orderBy: ORDER_BY,
    });
    const buffer = await buildBpMasterWorkbook(
      rows.flatMap((row) => {
        const master = row.adminAccounts[0];
        if (!master) return [];
        return [
          {
            ...summaryOf(row, master),
            bizCeoName: row.bizCeoName,
            ...ceoContactOf(row),
            bizOpenDate: dateOnly(row.bizOpenDate),
            bizZipCode: row.bizZipCode,
            bizAddress: row.bizAddress,
            bizAddressDetail: row.bizAddressDetail,
            bizCategory: row.bizCategory,
            bizItem: row.bizItem,
            bizVerifiedAt: row.bizVerifiedAt,
          },
        ];
      }),
    );
    return { fileName: bpMasterExcelFileName(), buffer };
  }

  /** 고객 BP 중 지우지 않은 것과 그 BP 마스터. 없으면 404. */
  private async findBp(
    db: Tx | PrismaService,
    bpCodeId: number,
  ): Promise<{ bp: BpRow; master: MasterRow }> {
    const bp = await db.bpCode.findFirst({
      where: { bpCodeId, isPlatform: false, isDeleted: false },
      select: bpSelect,
    });
    const master = bp?.adminAccounts[0];
    if (!bp || !master) throw new NotFoundException(NOT_FOUND);
    return { bp, master };
  }

  private countSubAdmins(db: Tx | PrismaService, bpCodeId: number) {
    return db.adminAccount.count({
      where: {
        bpCodeId,
        isDeleted: false,
        roleTypeCode: { in: SUB_ROLE_TYPES },
      },
    });
  }

  /** 지울 수 없는 이유. 오등록만 지운다 — 쓰인 흔적(로그인 · 하위 계정 · 점포)이 있으면 안 된다. */
  private async deletionReasons(
    db: Tx | PrismaService,
    bp: BpRow,
    master: MasterRow,
  ): Promise<string[]> {
    const [subAdmins, stores] = await Promise.all([
      this.countSubAdmins(db, bp.bpCodeId),
      db.store.count({ where: { bpCodeId: bp.bpCodeId, isDeleted: false } }),
    ]);
    return [
      bp.accountStatusCode === WITHDRAWN && '탈퇴한 BP는 삭제할 수 없습니다.',
      master.lastLoginAt &&
        'BP 마스터가 로그인한 적이 있어 삭제할 수 없습니다.',
      subAdmins > 0 && '하위 관리자 계정이 있어 삭제할 수 없습니다.',
      stores > 0 && '등록된 점포가 있어 삭제할 수 없습니다.',
    ].filter((r): r is string => typeof r === 'string');
  }

  /**
   * 사업자등록번호가 아직 비었는가 — 트랜잭션 안에서 본다. 인증과 저장 사이에 다른 BP · 점포가 같은 번호로 먼저
   * 들어왔을 수 있다. 점포 저장 · 가입 · MY PAGE 와 같은 번호별 잠금(stores:biz:<번호>)으로 줄을 선다.
   */
  private async assertNumberFree(
    tx: Tx,
    bizRegistrationNumber: string,
    excludeBpCodeId?: number,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`stores:biz:${bizRegistrationNumber}`}))`;
    if (
      await this.verifications.isBizRegistrationNumberTaken(
        bizRegistrationNumber,
        tx,
        excludeBpCodeId,
      )
    )
      throw new ConflictException(DUPLICATE_BIZ_REGISTRATION_NUMBER);
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
        accountStatusCode: { not: WITHDRAWN },
        ...(exceptAdminAccountId && {
          adminAccountId: { not: exceptAdminAccountId },
        }),
      },
      select: { adminAccountId: true },
    });
  }

  /** 부르기 전에 센다 — 동시에 여러 번 눌러도 한도를 넘지 않게(BpProfileService.countNtsCall 과 같다). */
  private countNtsCall(adminAccountId: number): void {
    const now = Date.now();
    const recent = (this.ntsCallsAt.get(adminAccountId) ?? []).filter(
      (at) => now - at < NTS_WINDOW_MS,
    );
    if (recent.length >= NTS_CALLS_PER_HOUR)
      throw new HttpException(
        `사업자 인증은 한 시간에 ${NTS_CALLS_PER_HOUR}번까지 할 수 있습니다. 잠시 후 다시 시도해 주세요`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    recent.push(now);
    this.ntsCallsAt.set(adminAccountId, recent);
    for (const [admin, times] of this.ntsCallsAt)
      if (times.every((at) => now - at >= NTS_WINDOW_MS))
        this.ntsCallsAt.delete(admin);
  }
}

/** 목록 · 엑셀의 조건. 고객 BP 중 지우지 않고 BP 마스터가 있는 것. */
function listWhere({
  searchType,
  keyword,
  statuses,
  verification,
}: BpMasterFilterDto): Prisma.BpCodeWhereInput {
  const keywordOr = keyword ? keywordConditions(keyword, searchType) : null;
  return {
    isPlatform: false,
    isDeleted: false,
    adminAccounts: { some: masterOnly },
    ...(statuses?.length && { accountStatusCode: { in: statuses } }),
    ...(verification === 'VERIFIED' && { bizVerifiedAt: { not: null } }),
    ...(verification === 'UNVERIFIED' && { bizVerifiedAt: null }),
    ...(keywordOr && { AND: [{ OR: keywordOr }] }),
  };
}

/** 검색어 조건. 검색 기준이 없으면 네 기준 중 어디든 맞으면 된다. 탈퇴 BP 는 이름으로 찾히지 않는다. */
function keywordConditions(
  keyword: string,
  searchType?: BpMasterFilterDto['searchType'],
): Prisma.BpCodeWhereInput[] {
  const contains = { contains: keyword, mode: 'insensitive' as const };
  const digits = keyword.replace(/[^0-9]/g, '');
  const byType: Record<string, Prisma.BpCodeWhereInput[]> = {
    BP_CODE: [{ bpCode: contains }],
    LOGIN_ID_NAME: [
      { adminAccounts: { some: { ...masterOnly, loginId: contains } } },
      {
        accountStatusCode: { not: WITHDRAWN },
        adminAccounts: { some: { ...masterOnly, name: contains } },
      },
    ],
    TRADE_NAME: [{ tradeName: contains }],
    // 번호는 숫자만 저장한다. 숫자가 없는 검색어는 그대로 둬 아무 번호와도 맞지 않게 한다.
    BIZ_REGISTRATION_NUMBER: [
      { bizRegistrationNumber: { contains: digits || keyword } },
    ],
  };
  return searchType ? byType[searchType] : Object.values(byType).flat();
}

function summaryOf(bp: BpRow, master: MasterRow): BpMasterSummaryResponseDto {
  // 탈퇴한 BP 의 개인정보는 내지 않는다 — 탈퇴 처리가 지우기 전이라도 화면은 「탈퇴로 삭제됨」이다.
  const isWithdrawn = bp.accountStatusCode === WITHDRAWN;
  return {
    bpCodeId: bp.bpCodeId,
    bpCode: bp.bpCode,
    loginId: master.loginId,
    name: isWithdrawn ? null : master.name,
    phone: isWithdrawn ? null : master.phone,
    email: isWithdrawn ? null : master.email,
    accountStatus: bp.accountStatusCode,
    tradeName: bp.tradeName,
    bizRegistrationNumber: bp.bizRegistrationNumber,
    joinPath: master.joinPathCode,
    createdAt: bp.createdAt,
    createdByName: bp.creator?.name ?? null,
  };
}

/** 대표자 연락처 · 이메일 — 탈퇴 때 지우는 개인정보라 탈퇴한 BP 는 내지 않는다(summaryOf 와 같다). */
function ceoContactOf(bp: BpRow) {
  const isWithdrawn = bp.accountStatusCode === WITHDRAWN;
  return {
    bizCeoPhone: isWithdrawn ? null : bp.bizCeoPhone,
    bizCeoEmail: isWithdrawn ? null : bp.bizCeoEmail,
  };
}

function assertNotWithdrawn(bp: { accountStatusCode: string }): void {
  if (bp.accountStatusCode === WITHDRAWN)
    throw new ConflictException(WITHDRAWN_BP);
}

/** 바로 고칠 수 있는 사업자 칸. 전체 치환이라 빠진 칸은 비운다. */
function bizProfileOf(input: UpdateBpMasterDto) {
  return {
    bizCeoPhone: input.bizCeoPhone ?? null,
    bizCeoEmail: input.bizCeoEmail ?? null,
    bizZipCode: input.bizZipCode ?? null,
    bizAddress: input.bizAddress ?? null,
    bizAddressDetail: input.bizAddressDetail ?? null,
    bizCategory: input.bizCategory ?? null,
    bizItem: input.bizItem ?? null,
  };
}

/** 진위확인 토큰에서만 꺼내는 세 값과 인증일시. */
function verifiedBizOf(biz: {
  bizRegistrationNumber: string;
  bizCeoName: string;
  bizOpenDate: string;
}) {
  return {
    bizRegistrationNumber: biz.bizRegistrationNumber,
    bizCeoName: biz.bizCeoName,
    bizOpenDate: new Date(`${biz.bizOpenDate}T00:00:00.000Z`),
    bizVerifiedAt: new Date(),
  };
}

/** BP 이력. verified 의 줄에는 「사업자 번호 인증」을 단다. */
async function recordBp(
  tx: Tx,
  bpCodeId: number,
  changedBy: number,
  changes: (History | null)[],
  verified: (History | null)[] = [],
): Promise<void> {
  const tag = (list: (History | null)[], note: string | null) =>
    list
      .filter((c): c is History => c !== null)
      .map((c) => ({ bpCodeId, ...c, changedBy, note }));
  const data = [...tag(changes, null), ...tag(verified, '사업자 번호 인증')];
  if (data.length) await tx.bpChangeHistory.createMany({ data });
}

async function recordAccount(
  tx: Tx,
  adminAccountId: number,
  changedBy: number,
  changes: (History | null)[],
): Promise<void> {
  const data = changes
    .filter((c): c is History => c !== null)
    .map((c) => ({ adminAccountId, ...c, changedBy }));
  if (data.length) await tx.adminChangeHistory.createMany({ data });
}

function change(
  field: string,
  beforeValue: string | null,
  afterValue: string | null,
): History | null {
  return beforeValue === afterValue ? null : { field, beforeValue, afterValue };
}

function dateOnly(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
