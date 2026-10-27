import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AdminScopeService,
  hidesPersonalData,
} from '../admin-scope/admin-scope.service';
import {
  HQ_SHARING_CONSENTED,
  HQ_SHARING_SELECT,
  hqSharingConsentStateOf,
  hqSharingConsentedOf,
} from '../admin-scope/hq-sharing';
import { isMobilePhone } from '../alimtalk/alimtalk.service';
import {
  adminHasMenuAction,
  reportMissingMenu,
} from '../auth/menu-permission.guard';
import { RESENDABLE_STATUSES } from '../contracts/contract-status';
import {
  CONTRACT_WORK_DAYS_SELECT,
  workDaysOf,
} from '../contracts/contract-terms';
import { CONTRACTS_MENU } from '../contracts/contracts-menu';
import { PrismaService } from '../prisma/prisma.service';
import { StaffMemberListQueryDto } from './dto/staff-member-list.query.dto';
import {
  StaffMemberDetailResponseDto,
  StaffMemberEmploymentPeriodDto,
  StaffMemberListItemDto,
  StaffMemberListResponseDto,
} from './dto/staff-member-list.response.dto';
import {
  displayInvitation,
  joinStateOf,
  joinStateWhere,
  type StaffJoinState,
} from './join-state';
import { dateOnly } from '../common/date-only';
import { isBirthDateCorrectable } from './birth-date-correctable';
import { linkedRecords } from './previous-records';

/**
 * 가입 초대를 다시 보낼 수 있는 가입 상태. 재발송 간격 제한은 없다(2026-10-12 재영). 가입 완료는 가입 초대가 아니라
 * 앱 알림이라 근로계약 상세에서 다시 보내고(WHALEERP-611), 초안(첫 발송은 초안 저장)은 보낸 초대가 없고, 연결 보류는
 * 「연결 확인」에서, 만 19세 미만 · 직원이 거절한 건은 다시 보내지 않는다. 소속 추가 확인 · 복귀 확인은 그 번호의 계정이
 * 탈퇴해 없어졌을 때만 재발송 api 가 가입 초대로 보낸다 — 계정은 toItems 가 번호로 한 번에 찾아 본다.
 */
const RESENDABLE = new Set<StaffJoinState>([
  'INVITED',
  'EXPIRED',
  'AFFILIATION_PENDING',
  'RETURN_PENDING',
]);

const STAFF_SELECT = {
  staffMemberId: true,
  storeId: true,
  name: true,
  phone: true,
  employmentType: true,
  joinStatus: true,
  employmentStatus: true,
  retiredDate: true,
  ...HQ_SHARING_SELECT,
  invitations: {
    orderBy: [{ sentAt: 'asc' }, { invitationId: 'asc' }],
    select: {
      invitationId: true,
      invitationType: true,
      status: true,
      sentAt: true,
      expiresAt: true,
      linkHolds: {
        where: { resolution: null },
        orderBy: [{ createdAt: 'desc' }, { linkHoldId: 'desc' }],
        // 보류 계정은 번호만 읽는다. 실명 · 다른 소속은 가입자의 정보라 관리자에게 보이지 않는다.
        select: {
          linkHoldId: true,
          mismatchReason: true,
          createdAt: true,
          account: { select: { phone: true } },
        },
      },
    },
  },
} satisfies Prisma.StaffMemberSelect;

type StaffRow = Prisma.StaffMemberGetPayload<{ select: typeof STAFF_SELECT }>;

/**
 * 상세만 읽는 칸 — 계정 이메일 · 상태 · 생년월일, 직무 · 입사일, 가장 최근 계약 1건의 당사자 생년월일. STAFF_SELECT 의
 * account 를 다시 쓰므로 본사 제공 동의 칸을 그 안에 펼친다 — 빠지면 모두 가려진다.
 */
const DETAIL_SELECT = {
  ...STAFF_SELECT,
  jobTitle: true,
  hiredDate: true,
  account: {
    select: {
      email: true,
      status: true,
      birthDate: true,
      ...HQ_SHARING_SELECT.account.select,
    },
  },
  // 가입 전 · 탈퇴 계정 직원의 생년월일 — 생년월일이 적힌 가장 최근 계약의 값. 최근 계약만 보면 새 계약을 생년월일 없이
  // 임시저장했을 때 예전 계약의 값이 사라진다. 정렬은 toItems 의 최근 계약과 같다
  contracts: {
    where: { contractParty: { enteredBirthDate: { not: null } } },
    orderBy: [
      { createdAt: { sort: 'desc', nulls: 'last' } },
      { contractId: 'desc' },
    ],
    take: 1,
    select: { contractParty: { select: { enteredBirthDate: true } } },
  },
} satisfies Prisma.StaffMemberSelect;
/** 체결 완료된 적이 있는 계약 — 상태 이력에 SIGNED 가 있다(종료 · 대체로 닫혀도 남는다) */
const SIGNED_CONTRACT = {
  contractStatusHistories: { some: { toStatus: 'SIGNED' } },
} satisfies Prisma.ContractWhereInput;
/** 재직 이력 한 칸 — 입사일 · 퇴직일, 가림 판정에 쓰는 동의, 체결 완료된 계약이 있는지(한 건만) */
const PERIOD_SELECT = {
  staffMemberId: true,
  hiredDate: true,
  retiredDate: true,
  ...HQ_SHARING_SELECT,
  contracts: { where: SIGNED_CONTRACT, select: { contractId: true }, take: 1 },
} satisfies Prisma.StaffMemberSelect;
type PeriodRow = Prisma.StaffMemberGetPayload<{
  select: typeof PERIOD_SELECT;
}>;

type ManageableStores = NonNullable<
  Awaited<ReturnType<AdminScopeService['getManageableStores']>>
>;

@Injectable()
export class StaffMemberListService {
  private readonly logger = new Logger(StaffMemberListService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: AdminScopeService,
  ) {}

  /** 직원 목록. 관리자 계정이 없거나 사용 중이 아니면 null(컨트롤러가 403). */
  async list(
    adminAccountId: number,
    query: StaffMemberListQueryDto,
  ): Promise<StaffMemberListResponseDto | null> {
    const [manageable, showsWorkDays] = await Promise.all([
      this.scope.getManageableStores(adminAccountId),
      this.canReadContracts(adminAccountId),
    ]);
    if (!manageable) return null;

    const hidden = (
      storeTypeCode: string | undefined,
      isHqSharingConsented: boolean,
    ) =>
      hidesPersonalData(
        manageable.roleTypeCode,
        storeTypeCode,
        isHqSharingConsented,
      );
    // 고른 점포 · 점포 유형은 관리 범위 안에서만 거르고 둘 다 맞아야 한다 — 범위 밖 id 는 조용히 빠진다(근로계약 목록과 같다)
    const types = query.storeTypes ? new Set<string>(query.storeTypes) : null;
    let stores = manageable.stores.filter(
      (s) =>
        (!query.storeIds || query.storeIds.includes(s.storeId)) &&
        (!types || types.has(s.storeTypeCode)),
    );
    // 점포 유형은 상단 범위 직영 · 가맹이라 폐점 점포는 뺀다 — TO-DO 목록 · 범위 칩과 같다. 폐점 점포는 전체 · 점포를
    // 골라 본다(2026-10-22 재영)
    if (types && stores.length > 0) {
      const open = new Set(
        (
          await this.prisma.store.findMany({
            where: {
              storeId: { in: stores.map((s) => s.storeId) },
              storeStatusCode: { not: 'CLOSED' },
            },
            select: { storeId: true },
          })
        ).map((s) => s.storeId),
      );
      stores = stores.filter((s) => open.has(s.storeId));
    }
    if (stores.length === 0) return { items: [], total: 0 };

    // 가린 칸으로 거르면 건수가 그 값을 알려 준다. 본사 역할이 개인 칸으로 거르면 동의하지 않은 직원이 가려지는
    // 점포에서는 동의한 직원만 남긴다. 재직 상태는 화면 기본 필터라 예외다 — 빼면 가린 행이 기본 화면에 나오지
    // 않는다. 드러나는 것은 점포별 퇴직자 수와 어느 가린 줄이 퇴직했는지다(2026-10-12 yjnoh).
    const filtersPersonal =
      query.keyword !== undefined ||
      query.employmentType !== undefined ||
      query.joinState !== undefined;
    const ids = (list: typeof stores) => list.map((s) => s.storeId);
    const masking = stores.filter((s) => hidden(s.storeTypeCode, false));
    const scopeWhere: Prisma.StaffMemberWhereInput =
      filtersPersonal && masking.length > 0
        ? {
            OR: [
              {
                storeId: {
                  in: ids(stores.filter((s) => !masking.includes(s))),
                },
              },
              { storeId: { in: ids(masking) }, ...HQ_SHARING_CONSENTED },
            ],
          }
        : { storeId: { in: ids(stores) } };

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where = this.whereOf(scopeWhere, query);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.staffMember.findMany({
        where,
        orderBy: { staffMemberId: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: STAFF_SELECT,
      }),
      this.prisma.staffMember.count({ where }),
    ]);
    if (rows.length === 0) return { items: [], total };
    return {
      items: await this.toItems(rows, manageable, showsWorkDays),
      total,
    };
  }

  /**
   * 직원 상세(WHALEERP-599). 목록 한 줄과 같은 값에 계정 이메일(회원 ID, WHALEERP-177 · 180)과 기본 정보 칸(직무 · 입사일 ·
   * 생년월일 · 본사 제공 동의 상태, WHALEERP-183 · 184)을 더한다 — 낼지는 아래 주석. 없거나 관리 범위 밖이거나
   * 가려지는 직원이면 null — 셋을 가르지 않아야 다른 BP 에 그 ID 의 직원이 있는지 드러나지 않는다(컨트롤러가 모두
   * 같은 404). 가린 직원은 목록에도 ID 가 없으므로 상세로 열 이유가 없다.
   */
  async findOne(
    adminAccountId: number,
    staffMemberId: number,
    now: Date = new Date(),
  ): Promise<StaffMemberDetailResponseDto | null> {
    const [manageable, showsWorkDays] = await Promise.all([
      this.scope.getManageableStores(adminAccountId),
      this.canReadContracts(adminAccountId),
    ]);
    if (!manageable) return null;
    const row = await this.prisma.staffMember.findFirst({
      where: {
        staffMemberId,
        storeId: { in: manageable.stores.map((s) => s.storeId) },
      },
      select: DETAIL_SELECT,
    });
    if (!row) return null;
    // 가림은 점포 · 계약을 읽기 전에 정한다. 읽은 뒤에 거르면 가려지는 직원의 404 만 그만큼 늦어, 응답 시간으로
    // 목록이 숨긴 ID 를 가려낼 수 있다. 판정은 목록(toItems)과 같은 값 — 관리 범위의 점포 유형과 행의 계정 동의다.
    const storeTypeCode = manageable.stores.find(
      (s) => s.storeId === row.storeId,
    )?.storeTypeCode;
    if (
      hidesPersonalData(
        manageable.roleTypeCode,
        storeTypeCode,
        hqSharingConsentedOf(row),
      )
    )
      return null;
    const [item] = await this.toItems([row], manageable, showsWorkDays);
    // 위 판정과 응답 줄의 가림은 같은 값이다. 한쪽 조건만 바뀌어도 가린 줄을 200 으로 내지 않게 한 번 더 거른다.
    if (item.isMasked) return null;
    // 이메일은 회원 ID 다. 직원이 근무지에 직접 와서 물으면 마주한 관리자가 알려 주고(ACC-16), 화면은 보이기만 하고
    // 고치지 못한다(ACC-17). 「상세는 목록보다 개인정보를 더 내지 않는다」(api #53)의 첫 번째 예외다(WHALEERP-180).
    // - 권한: 상세를 열 수 있는 관리자(직원 정보 관리 조회). 마주한 관리자가 조회만 켠 그룹일 수 있다(2026-10-16 영주).
    //   재설정 링크 발송은 여전히 수정 권한이라, 조회만 있으면 이메일은 보이고 링크는 403 이다.
    // - 범위: 점포 기준(canManageStaffAccount 와 같은 값, 동의를 넘기지 않음). 동의는 자료를 보는 데 대한 것이라 계정
    //   정보로 넓히지 않는다(2026-10-14 재영, ATT-30). 본사 역할에게 동의한 가맹 점포 직원은 null 이다.
    // - 상태: 가입 전 · 탈퇴 계정 · 퇴직 레코드는 null(퇴직 2026-10-16 영주).
    const showsEmail =
      !hidesPersonalData(manageable.roleTypeCode, storeTypeCode, false) &&
      row.employmentStatus !== 'RETIRED';
    const liveAccount =
      row.account && row.account.status !== 'WITHDRAWN' ? row.account : null;
    const email = showsEmail && liveAccount ? liveAccount.email : null;
    // 기본 정보 칸(WHALEERP-183). 생년월일은 api #53 의 두 번째 예외다. 근로계약서 당사자 정보에 이미 있고 날인 전 본인
    // 대조로 계정 값과 맞추므로, 가림만 지나면 본사 역할(동의한 가맹 직원) · 퇴직 레코드에도 낸다(2026-10-21 재영) —
    // 이메일은 계약서에 없는 계정 정보라 showsEmail 로 따로 막는다. 둘을 같은 조건으로 묶지 않는다. 가입한 계정 값을 먼저
    // 쓰고, 가입 전 · 탈퇴 계정이면 생년월일이 적힌 가장 최근 계약의 값이다. 입사일은 칸 그대로다.
    const birthDate =
      liveAccount?.birthDate ??
      row.contracts[0]?.contractParty?.enteredBirthDate ??
      null;
    // 재직 이력(WHALEERP-615). 같은 점포 레코드만 이어지지만 동의는 레코드(계정)마다라 따로 가린다 — 가입 전 레코드는
    // 동의가 없다.
    const hides = (r: PeriodRow) =>
      hidesPersonalData(
        manageable.roleTypeCode,
        storeTypeCode,
        hqSharingConsentedOf(r),
      );
    // 이전 · 이후는 서로 기대지 않아 함께 읽는다
    const [previousRecords, laterRecords] = await Promise.all([
      this.periodsOf(row, 'previous', hides),
      this.periodsOf(row, 'later', hides),
    ]);
    return {
      ...item,
      email,
      jobTitle: row.jobTitle,
      hiredDate: dateOnly(row.hiredDate),
      birthDate: dateOnly(birthDate),
      birthDateCorrectable: isBirthDateCorrectable(row, now),
      // 가맹 점포 직원에게만 「동의 · 미동의」 한 줄(WHALEERP-184). 본사 역할에게 미동의 직원은 위에서 이미 null(404)이라
      // 본사 역할이 보는 값은 늘 AGREED 다 — 미동의는 가맹 역할 · 플랫폼이 보는 값이다.
      hqSharingConsent: hqSharingConsentStateOf(storeTypeCode, row),
      previousRecords,
      laterRecords,
    };
  }

  /**
   * 재입사로 이은 재직 기간(WHALEERP-615). 이전은 이 레코드가 이은 앞 레코드들, 이후는 이 레코드를 (건너서라도) 이은 뒤
   * 레코드들 — 같은 레코드를 이은 것이 둘 이상이면 모두 — 이고 가까운 것부터다. 사슬은 재귀 쿼리 하나로 읽고(linkedRecords),
   * 그 레코드들을 한 번에 읽는다. 가려지거나 체결 완료된 계약이 없는 레코드(임시저장 · 발송만 한 재입사, 2026-10-23 김민식)는
   * 빼지만 그 너머는 그대로 낸다.
   */
  private async periodsOf(
    start: { staffMemberId: number; storeId: number },
    direction: 'previous' | 'later',
    hides: (row: PeriodRow) => boolean,
  ): Promise<StaffMemberEmploymentPeriodDto[]> {
    const linked = await linkedRecords(
      this.prisma,
      start.staffMemberId,
      start.storeId,
      direction,
    );
    if (linked.length === 0) return [];
    const rows = await this.prisma.staffMember.findMany({
      // 사슬은 같은 점포만 따라가지만, 이 점포 밖 레코드 · 가림 판정이 새지 않게 한 번 더 점포로 거른다
      where: {
        staffMemberId: { in: linked.map((r) => r.staffMemberId) },
        storeId: start.storeId,
      },
      select: PERIOD_SELECT,
    });
    const byId = new Map(rows.map((r) => [r.staffMemberId, r]));
    return linked.flatMap(({ staffMemberId }) => {
      const r = byId.get(staffMemberId);
      return r && r.contracts.length > 0 && !hides(r)
        ? [
            {
              staffMemberId,
              hiredDate: dateOnly(r.hiredDate),
              retiredDate: dateOnly(r.retiredDate),
            },
          ]
        : [];
    });
  }

  /**
   * 근로계약 관리 메뉴 조회 권한 — 가드와 같은 판정이다. 요청마다 한 번만 묻고 줄마다 묻지 않는다. 없으면 목록 · 상세의
   * 대표 계약 workDays 를 읽지도 내지도 않는다(null, 재영 결정 2026-10-27). 없으면 판정할 메뉴가 아예 없는지 로그를
   * 남긴다(홈의 canRead 와 같다).
   */
  private async canReadContracts(adminAccountId: number): Promise<boolean> {
    if (
      await adminHasMenuAction(this.prisma, adminAccountId, CONTRACTS_MENU, [
        'read',
      ])
    )
      return true;
    await reportMissingMenu(
      this.prisma,
      this.logger,
      CONTRACTS_MENU,
      StaffMemberListService.name,
    );
    return false;
  }

  /**
   * 직원 레코드를 응답 줄로 바꾼다. 점포 · 최근 계약을 읽고 가림 · 가입 상태 · 초대 · 보류를 정한다.
   * showsWorkDays 가 false 면 대표 계약의 근무 요일을 읽지 않고 workDays 를 null 로 낸다.
   */
  private async toItems(
    rows: StaffRow[],
    manageable: ManageableStores,
    showsWorkDays: boolean,
  ): Promise<StaffMemberListItemDto[]> {
    const hidden = (
      storeTypeCode: string | undefined,
      isHqSharingConsented: boolean,
    ) =>
      hidesPersonalData(
        manageable.roleTypeCode,
        storeTypeCode,
        isHqSharingConsented,
      );
    // 가림은 관리 범위를 정할 때 읽은 점포 유형과 행의 계정 동의로 판단한다 — 점포 유형은 목록을 거른 것과 같은
    // 값이다.
    const typeById = new Map(
      manageable.stores.map((s) => [s.storeId, s.storeTypeCode]),
    );
    const staffIds = rows.map((r) => r.staffMemberId);
    // 재발송을 물을 줄 — 가린 줄은 칸을 내지 않으니 묻지 않는다
    const askable = (r: StaffRow) =>
      !hidden(typeById.get(r.storeId), hqSharingConsentedOf(r)) &&
      RESENDABLE.has(joinStateOf(r.joinStatus, r.invitations)) &&
      isMobilePhone(r.phone);
    const askPhones = [
      ...new Set(rows.filter((r) => askable(r)).map((r) => r.phone)),
    ];
    const [storeRows, contracts, accountRows] = await Promise.all([
      this.prisma.store.findMany({
        where: { storeId: { in: [...new Set(rows.map((r) => r.storeId))] } },
        select: { storeId: true, name: true, storeTypeCode: true },
      }),
      this.prisma.contract.findMany({
        where: { staffMemberId: { in: staffIds } },
        distinct: ['staffMemberId'],
        // created_at 은 nullable 이다. DESC 의 기본은 NULL 먼저라 오래된 계약이 「최근」이 될 수 있다.
        orderBy: [
          { staffMemberId: 'asc' },
          { createdAt: { sort: 'desc', nulls: 'last' } },
          { contractId: 'desc' },
        ],
        select: {
          staffMemberId: true,
          contractId: true,
          status: true,
          signDeadlineAt: true,
          endDate: true,
          updatedAt: true,
          // 중첩 select 라 Prisma 가 한 번에 IN 으로 읽는다 — 직원 수만큼 쿼리가 늘지 않는다(WHALEERP-622)
          ...(showsWorkDays
            ? { contractWorkDays: CONTRACT_WORK_DAYS_SELECT }
            : {}),
        },
      }),
      // 재발송 api 가 판별할 「그 번호의 계정」(decideInvitation — 탈퇴하지 않은 계정)이 있는 번호를 한 번에 찾는다.
      // 있으면 소속 추가 확인 · 복귀 확인이라 409 다(줄마다 묻지 않는다)
      askPhones.length
        ? this.prisma.account.findMany({
            where: {
              phone: { in: askPhones },
              status: { not: 'WITHDRAWN' },
            },
            select: { phone: true },
          })
        : Promise.resolve<{ phone: string }[]>([]),
    ]);

    const storeById = new Map(storeRows.map((s) => [s.storeId, s]));
    const accountPhones = new Set(accountRows.map((a) => a.phone));
    const contractByStaff = new Map(contracts.map((c) => [c.staffMemberId, c]));

    return rows.map((r): StaffMemberListItemDto => {
      const store = storeById.get(r.storeId);
      // 직원 레코드의 점포는 외래키로 묶여 있다. 못 찾으면 데이터가 깨진 것이라 빈 칸으로 내보내지 않는다.
      if (!store)
        throw new InternalServerErrorException(
          `직원 ${r.staffMemberId} 의 점포 ${r.storeId} 를 찾을 수 없습니다`,
        );
      const storeDto = {
        storeId: r.storeId,
        name: store.name,
        storeType: store.storeTypeCode,
      };
      if (hidden(typeById.get(r.storeId), hqSharingConsentedOf(r))) {
        // ID 도 내지 않는다. 직원 단위 API 도 막혀 있지만(canManageStaffMember), 목록이 열쇠를 건넬 이유가 없다.
        return {
          staffMemberId: null,
          isMasked: true,
          name: null,
          phone: null,
          store: storeDto,
          employmentType: null,
          joinState: null,
          invitation: null,
          linkHold: null,
          contract: null,
          employmentStatus: null,
          retiredDate: null,
        };
      }
      const shown = displayInvitation(r.invitations);
      const hold = r.invitations
        .flatMap((i) => i.linkHolds)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      const contract = contractByStaff.get(r.staffMemberId);
      const joinState = joinStateOf(r.joinStatus, r.invitations);
      return {
        staffMemberId: r.staffMemberId,
        isMasked: false,
        name: r.name,
        phone: r.phone,
        store: storeDto,
        employmentType: r.employmentType,
        joinState,
        invitation: shown
          ? {
              invitationType: shown.invitationType,
              status: shown.status,
              lastSentAt: shown.sentAt,
              expiresAt: shown.expiresAt,
              // 재발송 api(contract-send)의 판정과 같다 — 계약이 발송 대기 · 서명 대기, 가입 전, 그 번호에 계정 없음,
              // 휴대폰 번호. 이미 수락한 초대는 다시 보내지 않는다 — 받은 링크로 다시 들어온다(2026-10-12 yjnoh).
              canResend:
                askable(r) &&
                shown.status !== 'ACCEPTED' &&
                !accountPhones.has(r.phone) &&
                !!contract?.status &&
                RESENDABLE_STATUSES.includes(contract.status),
            }
          : null,
        linkHold: hold
          ? {
              linkHoldId: hold.linkHoldId,
              mismatchReason: hold.mismatchReason,
              verifiedPhoneLast4: hold.account.phone.slice(-4),
              heldAt: hold.createdAt,
            }
          : null,
        contract: contract
          ? {
              contractId: contract.contractId,
              status: contract.status,
              signDeadlineAt: contract.signDeadlineAt,
              endDate: dateOnly(contract.endDate),
              updatedAt: contract.updatedAt,
              workDays: showsWorkDays
                ? workDaysOf(contract.contractWorkDays ?? [])
                : null,
            }
          : null,
        employmentStatus: r.employmentStatus,
        retiredDate: dateOnly(r.retiredDate),
      };
    });
  }

  private whereOf(
    scopeWhere: Prisma.StaffMemberWhereInput,
    query: StaffMemberListQueryDto,
  ): Prisma.StaffMemberWhereInput {
    const and: Prisma.StaffMemberWhereInput[] = [scopeWhere];
    const keyword = query.keyword?.trim();
    if (keyword) {
      const digits = keyword.replace(/\D/g, '');
      and.push({
        OR: [
          { name: { contains: keyword, mode: 'insensitive' } },
          ...(digits ? [{ phone: { contains: digits } }] : []),
        ],
      });
    }
    if (query.employmentType)
      and.push({ employmentType: { in: query.employmentType } });
    if (query.employmentStatus)
      and.push({ employmentStatus: query.employmentStatus });
    if (query.joinState)
      and.push({ OR: query.joinState.map((state) => joinStateWhere(state)) });
    return { AND: and };
  }
}
