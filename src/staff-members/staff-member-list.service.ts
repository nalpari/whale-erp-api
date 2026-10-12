import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AdminScopeService } from '../admin-scope/admin-scope.service';
import { PrismaService } from '../prisma/prisma.service';
import { StaffMemberListQueryDto } from './dto/staff-member-list.query.dto';
import {
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
 * 본사 역할(BP 마스터 · BP 관리자). 가맹 점포 직원은 본사 제공 동의를 한 경우에만 개인 단위로 본다
 * (운영 정책 ATT-30). 동의 칸(hq_sharing_consent)이 아직 없어 지금은 모두 동의 없음이다 — 칸이 생기면 두 곳에
 * 「동의했으면 가리지 않는다」를 더한다: 아래 items 조립의 가림 판단, 개인 칸으로 거를 때 가맹 점포를 빼는
 * storeIds 계산(WHALEERP-137).
 */
const HQ_ROLES = new Set(['BM', 'BA']);
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
const DIRECT = 'DIRECT';

const STAFF_SELECT = {
  staffMemberId: true,
  storeId: true,
  name: true,
  phone: true,
  employmentType: true,
  joinStatus: true,
  employmentStatus: true,
  retiredDate: true,
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

    const isHq = HQ_ROLES.has(manageable.roleTypeCode);
    // 가린 칸으로 거르면 건수가 그 값을 알려 준다. 본사 역할이 개인 칸으로 거르면 가맹 점포를 뺀다. 재직 상태는
    // 화면 기본 필터라 예외다 — 빼면 가린 행이 기본 화면에 나오지 않는다. 드러나는 것은 점포별 퇴직자 수뿐이다
    // (2026-10-12 yjnoh).
    const filtersPersonal =
      query.keyword !== undefined ||
      query.employmentType !== undefined ||
      query.joinState !== undefined;
    const storeIds = manageable.stores
      .filter((s) => !query.storeIds || query.storeIds.includes(s.storeId))
      .filter((s) => !(isHq && filtersPersonal && s.storeTypeCode !== DIRECT))
      .map((s) => s.storeId);
    if (storeIds.length === 0) return { items: [], total: 0 };

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where = this.whereOf(storeIds, query);
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

    const ids = rows.map((r) => r.staffMemberId);
    const [stores, contracts] = await Promise.all([
      this.prisma.store.findMany({
        where: { storeId: { in: [...new Set(rows.map((r) => r.storeId))] } },
        select: { storeId: true, name: true, storeTypeCode: true },
      }),
      this.prisma.contract.findMany({
        where: { staffMemberId: { in: ids } },
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

    const storeById = new Map(stores.map((s) => [s.storeId, s]));
    // 가림은 관리 범위를 정할 때 읽은 점포 유형으로 판단한다 — 목록을 거른 것과 같은 값이다. 직영이 아니면(모르는
    // 유형 포함) 가린다. 개인정보 규칙은 판단이 틀릴 때 가리는 쪽이어야 한다.
    const typeById = new Map(
      manageable.stores.map((s) => [s.storeId, s.storeTypeCode]),
    );
    const contractByStaff = new Map(contracts.map((c) => [c.staffMemberId, c]));

    const items = rows.map((r): StaffMemberListItemDto => {
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
      if (isHq && typeById.get(r.storeId) !== DIRECT) {
        return {
          staffMemberId: r.staffMemberId,
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
    return { items, total };
  }

  private whereOf(
    storeIds: number[],
    query: StaffMemberListQueryDto,
  ): Prisma.StaffMemberWhereInput {
    const and: Prisma.StaffMemberWhereInput[] = [{ storeId: { in: storeIds } }];
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
