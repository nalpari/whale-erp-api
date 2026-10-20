import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AdminScopeService,
  hidesPersonalData,
} from '../admin-scope/admin-scope.service';
import {
  HQ_SHARING_CONSENTED,
  HQ_SHARING_SELECT,
  hqSharingConsentedOf,
} from '../admin-scope/hq-sharing';
import { PrismaService } from '../prisma/prisma.service';
import { StaffMemberListQueryDto } from './dto/staff-member-list.query.dto';
import {
  StaffMemberDetailResponseDto,
  StaffMemberListItemDto,
  StaffMemberListResponseDto,
} from './dto/staff-member-list.response.dto';
import {
  displayInvitation,
  joinStateOf,
  joinStateWhere,
  type StaffJoinState,
} from './join-state';

/**
 * 초대를 다시 보낼 수 있는 상태. 재발송 간격 제한은 없다(2026-10-12 재영) — 상태로만 정한다. 가입 완료 · 초안(첫
 * 발송은 초안 저장)은 보낼 초대가 없고, 연결 보류는 「연결 확인」에서, 만 19세 미만 · 직원이 거절한 건은 다시
 * 보내지 않는다.
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
 * 상세만 계정 이메일 · 상태를 읽는다. STAFF_SELECT 의 account 를 다시 쓰므로 본사 제공 동의 칸을 그 안에 펼친다 — 빠지면
 * 모두 가려진다.
 */
const DETAIL_SELECT = {
  ...STAFF_SELECT,
  account: {
    select: { email: true, status: true, ...HQ_SHARING_SELECT.account.select },
  },
} satisfies Prisma.StaffMemberSelect;
type ManageableStores = NonNullable<
  Awaited<ReturnType<AdminScopeService['getManageableStores']>>
>;

const dateOnly = (date: Date | null) =>
  date ? date.toISOString().slice(0, 10) : null;

@Injectable()
export class StaffMemberListService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: AdminScopeService,
  ) {}

  /** 직원 목록. 관리자 계정이 없거나 사용 중이 아니면 null(컨트롤러가 403). */
  async list(
    adminAccountId: number,
    query: StaffMemberListQueryDto,
  ): Promise<StaffMemberListResponseDto | null> {
    const manageable = await this.scope.getManageableStores(adminAccountId);
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
    const stores = manageable.stores.filter(
      (s) => !query.storeIds || query.storeIds.includes(s.storeId),
    );
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
    return { items: await this.toItems(rows, manageable), total };
  }

  /**
   * 직원 상세(WHALEERP-599). 목록 한 줄과 같은 값에 계정 이메일(회원 ID)을 더한다(WHALEERP-177 · 180, 낼지는 아래 주석). 없거나 관리 범위 밖이거나
   * 가려지는 직원이면 null — 셋을 가르지 않아야 다른 BP 에 그 ID 의 직원이 있는지 드러나지 않는다(컨트롤러가 모두
   * 같은 404). 가린 직원은 목록에도 ID 가 없으므로 상세로 열 이유가 없다.
   */
  async findOne(
    adminAccountId: number,
    staffMemberId: number,
  ): Promise<StaffMemberDetailResponseDto | null> {
    const manageable = await this.scope.getManageableStores(adminAccountId);
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
    const [item] = await this.toItems([row], manageable);
    // 위 판정과 응답 줄의 가림은 같은 값이다. 한쪽 조건만 바뀌어도 가린 줄을 200 으로 내지 않게 한 번 더 거른다.
    if (item.isMasked) return null;
    // 이메일은 회원 ID 다. 직원이 근무지에 직접 와서 물으면 마주한 관리자가 알려 주고(ACC-16), 화면은 보이기만 하고
    // 고치지 못한다(ACC-17). 「상세는 목록보다 개인정보를 더 내지 않는다」(api #53)의 예외다(WHALEERP-180).
    // - 권한: 상세를 열 수 있는 관리자(직원 정보 관리 조회). 마주한 관리자가 조회만 켠 그룹일 수 있다(2026-10-16 영주).
    //   재설정 링크 발송은 여전히 수정 권한이라, 조회만 있으면 이메일은 보이고 링크는 403 이다.
    // - 범위: 점포 기준(canManageStaffAccount 와 같은 값, 동의를 넘기지 않음). 동의는 자료를 보는 데 대한 것이라 계정
    //   정보로 넓히지 않는다(2026-10-14 재영, ATT-30). 본사 역할에게 동의한 가맹 점포 직원은 null 이다.
    // - 상태: 가입 전 · 탈퇴 계정 · 퇴직 레코드는 null(퇴직 2026-10-16 영주).
    const showsEmail =
      !hidesPersonalData(manageable.roleTypeCode, storeTypeCode, false) &&
      row.employmentStatus !== 'RETIRED';
    const email =
      showsEmail && row.account && row.account.status !== 'WITHDRAWN'
        ? row.account.email
        : null;
    return { ...item, email };
  }

  /** 직원 레코드를 응답 줄로 바꾼다. 점포 · 최근 계약을 읽고 가림 · 가입 상태 · 초대 · 보류를 정한다. */
  private async toItems(
    rows: StaffRow[],
    manageable: ManageableStores,
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
    const staffIds = rows.map((r) => r.staffMemberId);
    const [storeRows, contracts] = await Promise.all([
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
        },
      }),
    ]);

    const storeById = new Map(storeRows.map((s) => [s.storeId, s]));
    // 가림은 관리 범위를 정할 때 읽은 점포 유형과 행의 계정 동의로 판단한다 — 점포 유형은 목록을 거른 것과 같은
    // 값이다.
    const typeById = new Map(
      manageable.stores.map((s) => [s.storeId, s.storeTypeCode]),
    );
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
              // 이미 수락한 초대는 다시 보내지 않는다 — 받은 링크로 다시 들어온다(2026-10-12 yjnoh).
              canResend:
                RESENDABLE.has(joinState) && shown.status !== 'ACCEPTED',
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
