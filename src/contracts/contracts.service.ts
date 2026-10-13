import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Weekday } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ContractDetailDto,
  ContractListResponseDto,
} from './dto/contract.response.dto';
import {
  ContractWorkDayDto,
  CreateContractDto,
  CreatedContractResponseDto,
} from './dto/create-contract.dto';
import { ListContractsQueryDto } from './dto/list-contracts-query.dto';

const isoDate = (d: Date) => d.toISOString().slice(0, 10);
// date 컬럼은 UTC 자정, time 컬럼은 1970-01-01 의 그 시각으로 넘긴다. 시간대가 끼면 하루 · 몇 시간씩 밀린다.
const toDate = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
const toTime = (hm: string) => new Date(`1970-01-01T${hm}:00.000Z`);

/** on 날짜에 만 몇 살인지. 생일 당일에 한 살 는다. */
export function ageOn(birth: string, on: string): number {
  const [by, bm, bd] = birth.split('-').map(Number);
  const [oy, om, od] = on.split('-').map(Number);
  return oy - by - (om < bm || (om === bm && od < bd) ? 1 : 0);
}

// HH:mm 은 글자 비교가 시각 비교와 같다.
function checkWorkDay(d: ContractWorkDayDto) {
  if (d.endTime <= d.startTime)
    throw new BadRequestException(
      `${d.weekday}: 종업은 시업보다 뒤여야 합니다`,
    );
  if (!d.breakStartTime !== !d.breakEndTime)
    throw new BadRequestException(
      `${d.weekday}: 휴게는 시작과 종료를 함께 넣습니다`,
    );
  if (
    d.breakStartTime &&
    d.breakEndTime &&
    !(
      d.breakStartTime >= d.startTime &&
      d.breakEndTime > d.breakStartTime &&
      d.breakEndTime <= d.endTime
    )
  )
    throw new BadRequestException(
      `${d.weekday}: 휴게는 근무 시간 안이어야 합니다`,
    );
}

const hhmm = (d: Date) => d.toISOString().slice(11, 16);

/** 저장 · 이어 쓰기가 같이 쓰는 입력 검사. 임시저장은 계약 칸을 비울 수 있어 넣은 값만 본다. */
function checkInput(dto: CreateContractDto): void {
  if (dto.startDate && dto.endDate && dto.endDate < dto.startDate)
    throw new BadRequestException('계약 종료일은 시작일보다 앞설 수 없습니다');
  // 운영 정책 ACC-22 — 계약 시작일 기준. 초대도 나가지 않는다.
  if (
    dto.birthDate &&
    dto.startDate &&
    ageOn(dto.birthDate, dto.startDate) < 19
  )
    throw new BadRequestException(
      '만 19세 미만 직원은 등록할 수 없습니다 (계약 시작일 기준)',
    );
  const workDays = dto.workDays ?? [];
  const weekdays = new Set(workDays.map((d) => d.weekday));
  if (weekdays.size !== workDays.length)
    throw new BadRequestException('같은 요일을 두 번 넣었습니다');
  workDays.forEach(checkWorkDay);
}

const minutesOf = (hm: string) =>
  Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const WEEKDAYS_FROM_SUNDAY = [
  'SUN',
  'SAT',
  'FRI',
  'THU',
  'WED',
  'TUE',
  'MON',
] as const;

/**
 * 주휴일 규칙 — 지금은 저장에 쓰지 않는다(7일 근무를 협의 중, 2026-10-08). 화면에서 고르지 않고 근무 요일 · 시간으로 정한다. 주 소정근로시간(종업 − 시업 − 휴게의 합)이
 * 15시간 이상이면 월~일 중 근무하지 않는 가장 뒤 요일, 15시간 미만이면 없음(NULL — 주휴 대상이 아니다, 운영 정책 PAY-02).
 * 15시간 이상인데 7일 모두 근무하면 둘 요일이 없어 저장하지 않는다.
 */
export function weeklyHolidayOf(
  workDays: ContractWorkDayDto[],
): Weekday | null {
  const minutes = workDays.reduce(
    (sum, d) =>
      sum +
      minutesOf(d.endTime) -
      minutesOf(d.startTime) -
      (d.breakStartTime && d.breakEndTime
        ? minutesOf(d.breakEndTime) - minutesOf(d.breakStartTime)
        : 0),
    0,
  );
  if (minutes < 15 * 60) return null;
  const working = new Set(workDays.map((d) => d.weekday));
  const off = WEEKDAYS_FROM_SUNDAY.find((w) => !working.has(w));
  if (!off)
    throw new BadRequestException(
      '주 15시간 이상이면 주휴일로 둘 쉬는 요일이 있어야 합니다',
    );
  return off;
}

/** 임시저장은 상태만 다르다. 지금은 초안 저장도 초대를 보내지 않는다 — 초대 발송이 생기면 여기서 갈린다. */
const statusOf = (dto: CreateContractDto) =>
  dto.isTemporarySave ? ('DRAFT' as const) : ('PENDING_SEND' as const);

/** contracts 칸. 비운 칸은 NULL 로 덮는다 — 이어 쓰기는 폼 전체를 다시 받는다. */
function contractFields(dto: CreateContractDto) {
  return {
    storeId: dto.storeId,
    employmentType: dto.employmentType,
    contractMethod: dto.contractMethod,
    startDate: dto.startDate ? toDate(dto.startDate) : null,
    endDate: dto.endDate ? toDate(dto.endDate) : null,
    workLocation: dto.workLocation ?? null,
    // 7일 모두 근무하는 경우를 협의하기 전까지 주휴일은 저장하지 않는다(2026-10-08). 규칙은 weeklyHolidayOf 에 남겨 둔다.
    weeklyHoliday: null,
    wageAmount: dto.wageAmount ?? null,
    payMonth: dto.payMonth ?? null,
    payDay: dto.payDay ?? null,
    isHealthPensionInsured: dto.isHealthPensionInsured ?? null,
    isEmploymentInjuryInsured: dto.isEmploymentInjuryInsured ?? null,
    status: statusOf(dto),
  };
}

const workDayRows = (dto: CreateContractDto) =>
  (dto.workDays ?? []).map((d) => ({
    weekday: d.weekday,
    startTime: toTime(d.startTime),
    endTime: toTime(d.endTime),
    breakStartTime: d.breakStartTime ? toTime(d.breakStartTime) : null,
    breakEndTime: d.breakEndTime ? toTime(d.breakEndTime) : null,
  }));

const partyFields = (dto: CreateContractDto) => ({
  enteredName: dto.name,
  enteredPhone: dto.phone,
  enteredBirthDate: dto.birthDate ? toDate(dto.birthDate) : null,
});

const staffMemberFields = (dto: CreateContractDto) => ({
  storeId: dto.storeId,
  name: dto.name,
  phone: dto.phone,
  employmentType: dto.employmentType,
  jobTitle: dto.jobTitle,
});

type Invitation = {
  draftAction:
    'SIGNUP_INVITE' | 'AFFILIATION_CONFIRM' | 'RETURN_CONFIRM' | null;
  candidateAccountId: number | null;
};
const NOT_YET: Invitation = { draftAction: null, candidateAccountId: null };

/**
 * 초대 유형 판별 (목업 contracts-new 「초대 유형 판별 규칙」). 휴대전화번호로 계정을 찾고 이 점포의 그 계정 레코드를 본다.
 *   계정 없음 → 가입 초대 / 계정 있음 · 이 점포 레코드 없음 → 소속 추가 확인 / 퇴직 레코드 → 복귀 확인 / 재직 중 → 409.
 * 번호는 고유가 아니어서(번호를 넘겨받는 일이 있다) 가장 최근에 만든 계정을 본다. 재초대는 「초대 재발송」의 일이라 여기 없다.
 * 판별만 남긴다 — 발송이 생기기 전까지 invitations 행 · 토큰 · join_status INVITED 는 만들지 않는다(「발송했다」가 아니므로).
 */
async function decideInvitation(
  db: Prisma.TransactionClient,
  storeId: number,
  phone: string,
): Promise<Invitation> {
  const [account] = await db.account.findMany({
    where: { phone },
    select: { accountId: true },
    orderBy: [{ createdAt: 'desc' }, { accountId: 'desc' }],
    take: 1,
  });
  if (!account)
    return { draftAction: 'SIGNUP_INVITE', candidateAccountId: null };
  const records = await db.staffMember.findMany({
    where: { storeId, accountId: account.accountId },
    select: { employmentStatus: true },
  });
  if (records.some((r) => r.employmentStatus === 'EMPLOYED'))
    throw new ConflictException('이 점포에 이미 재직 중인 직원입니다');
  return {
    draftAction: records.length ? 'RETURN_CONFIRM' : 'AFFILIATION_CONFIRM',
    candidateAccountId: account.accountId,
  };
}

@Injectable()
export class ContractsService {
  constructor(private readonly prisma: PrismaService) {}

  private async checkStore(storeId: number): Promise<void> {
    const store = await this.prisma.store.findFirst({
      where: { storeId, isDeleted: false, storeStatusCode: { not: 'CLOSED' } },
      select: { storeId: true },
    });
    if (!store) throw new NotFoundException('근무지 점포를 찾을 수 없습니다');
  }

  /**
   * 근로계약서 초안 저장. 미가입 직원 레코드(초안)와 발송 대기 계약을 한 번의 중첩 쓰기로 만든다 — 중간에
   * 실패하면 아무것도 남지 않는다. 초대 유형 판별과 발송은 아직 하지 않는다(draft_action 은 비워 둔다).
   */
  async create(
    dto: CreateContractDto,
    adminAccountId: number,
  ): Promise<CreatedContractResponseDto> {
    checkInput(dto);
    await this.checkStore(dto.storeId);

    // 목업의 초대 유형 판별 「이 점포 재직 중 → 차단」. 계정 조회 전이라도 레코드로 막을 수 있다.
    const employed = await this.prisma.staffMember.findFirst({
      where: {
        storeId: dto.storeId,
        phone: dto.phone,
        employmentStatus: 'EMPLOYED',
      },
      select: { staffMemberId: true },
    });
    if (employed)
      throw new ConflictException(
        '이 점포에 같은 번호로 재직 중인 직원이 있습니다',
      );

    const fields = contractFields(dto);
    // 임시저장은 판별하지 않는다 — 초안 저장(발송 대기)으로 넘어갈 때 한다.
    const invite =
      fields.status === 'DRAFT'
        ? NOT_YET
        : await decideInvitation(this.prisma, dto.storeId, dto.phone);
    const staffMember = await this.prisma.staffMember.create({
      data: {
        ...staffMemberFields(dto),
        joinStatus: 'DRAFT',
        candidateAccountId: invite.candidateAccountId,
        contracts: {
          create: {
            ...fields,
            draftAction: invite.draftAction,
            createdBy: adminAccountId,
            contractParty: { create: partyFields(dto) },
            contractWorkDays: { create: workDayRows(dto) },
            contractStatusHistories: {
              create: { toStatus: fields.status, actor: 'ADMIN' },
            },
          },
        },
      },
      select: {
        staffMemberId: true,
        contracts: { select: { contractId: true } },
      },
    });
    return {
      contractId: staffMember.contracts[0].contractId,
      staffMemberId: staffMember.staffMemberId,
    };
  }

  /** 작성 화면을 다시 채울 값. 임시저장 이어 쓰기가 쓴다. */
  async findOne(contractId: number): Promise<ContractDetailDto> {
    const c = await this.prisma.contract.findUnique({
      where: { contractId },
      select: {
        contractId: true,
        staffMemberId: true,
        storeId: true,
        status: true,
        contractMethod: true,
        startDate: true,
        endDate: true,
        workLocation: true,
        weeklyHoliday: true,
        wageAmount: true,
        payMonth: true,
        payDay: true,
        isHealthPensionInsured: true,
        isEmploymentInjuryInsured: true,
        draftAction: true,
        // 최근 것부터. 같은 시각(초안 저장과 자동 발송이 한 번에)이면 나중에 쓴 줄이 먼저다.
        contractStatusHistories: {
          orderBy: [{ changedAt: 'desc' }, { contractStatusHistoryId: 'desc' }],
          select: {
            fromStatus: true,
            toStatus: true,
            actor: true,
            changedAt: true,
          },
        },
        staffMember: {
          select: {
            name: true,
            phone: true,
            jobTitle: true,
            employmentType: true,
          },
        },
        contractParty: { select: { enteredBirthDate: true } },
        // weekday enum 순서(MON → SUN)로 정렬된다.
        contractWorkDays: {
          orderBy: { weekday: 'asc' },
          select: {
            weekday: true,
            startTime: true,
            endTime: true,
            breakStartTime: true,
            breakEndTime: true,
          },
        },
      },
    });
    if (!c) throw new NotFoundException('근로계약을 찾을 수 없습니다');
    // stores 는 1팀 테이블이라 Prisma 관계가 없다. 이름만 따로 읽는다(지운 점포여도 이름은 보인다).
    const store = await this.prisma.store.findUnique({
      where: { storeId: c.storeId },
      select: { name: true },
    });
    const birth = c.contractParty?.enteredBirthDate;
    return {
      contractId: c.contractId,
      staffMemberId: c.staffMemberId,
      status: c.status,
      name: c.staffMember.name,
      phone: c.staffMember.phone,
      jobTitle: c.staffMember.jobTitle,
      // 고용 형태는 직원 레코드가 원본이다(계약 칸은 그 사본).
      employmentType: c.staffMember.employmentType,
      storeId: c.storeId,
      storeName: store?.name ?? null,
      birthDate: birth ? isoDate(birth) : null,
      contractMethod: c.contractMethod,
      startDate: c.startDate ? isoDate(c.startDate) : null,
      endDate: c.endDate ? isoDate(c.endDate) : null,
      workLocation: c.workLocation,
      weeklyHoliday: c.weeklyHoliday,
      wageAmount: c.wageAmount,
      payMonth: c.payMonth,
      payDay: c.payDay,
      isHealthPensionInsured: c.isHealthPensionInsured,
      isEmploymentInjuryInsured: c.isEmploymentInjuryInsured,
      draftAction: c.draftAction,
      histories: c.contractStatusHistories.map((h) => ({
        fromStatus: h.fromStatus,
        toStatus: h.toStatus,
        actor: h.actor,
        changedAt: h.changedAt.toISOString(),
      })),
      workDays: c.contractWorkDays.map((d) => ({
        weekday: d.weekday,
        startTime: hhmm(d.startTime),
        endTime: hhmm(d.endTime),
        breakStartTime: d.breakStartTime ? hhmm(d.breakStartTime) : null,
        breakEndTime: d.breakEndTime ? hhmm(d.breakEndTime) : null,
      })),
    };
  }

  /**
   * 임시저장 이어 쓰기. 폼 전체를 다시 받아 덮어쓴다. 임시저장(DRAFT)일 때만 고칠 수 있고, 초안 저장으로
   * 넘기면(isTemporarySave 없음) 발송 대기가 되며 상태 이력을 남긴다. 한 트랜잭션이라 중간에 실패하면 그대로다.
   */
  async update(
    contractId: number,
    dto: CreateContractDto,
  ): Promise<CreatedContractResponseDto> {
    checkInput(dto);
    await this.checkStore(dto.storeId);
    const fields = contractFields(dto);

    return this.prisma.$transaction(async (tx) => {
      const current = await tx.contract.findUnique({
        where: { contractId },
        select: { status: true, staffMemberId: true },
      });
      if (!current) throw new NotFoundException('근로계약을 찾을 수 없습니다');
      if (current.status !== 'DRAFT')
        throw new ConflictException('임시저장한 근로계약서만 고칠 수 있습니다');

      const employed = await tx.staffMember.findFirst({
        where: {
          storeId: dto.storeId,
          phone: dto.phone,
          employmentStatus: 'EMPLOYED',
          staffMemberId: { not: current.staffMemberId },
        },
        select: { staffMemberId: true },
      });
      if (employed)
        throw new ConflictException(
          '이 점포에 같은 번호로 재직 중인 직원이 있습니다',
        );

      const invite =
        fields.status === 'DRAFT'
          ? NOT_YET
          : await decideInvitation(tx, dto.storeId, dto.phone);

      // 읽은 뒤 다른 요청이 먼저 넘겼으면(상태가 바뀌었으면) 0건이다. 그때는 아무것도 쓰지 않는다.
      const { count } = await tx.contract.updateMany({
        where: { contractId, status: 'DRAFT' },
        data: { ...fields, draftAction: invite.draftAction },
      });
      if (count === 0)
        throw new ConflictException('임시저장한 근로계약서만 고칠 수 있습니다');

      await tx.staffMember.update({
        where: { staffMemberId: current.staffMemberId },
        data: {
          ...staffMemberFields(dto),
          candidateAccountId: invite.candidateAccountId,
        },
      });
      await tx.contractParty.upsert({
        where: { contractId },
        update: partyFields(dto),
        create: { contractId, ...partyFields(dto) },
      });
      await tx.contractWorkDay.deleteMany({ where: { contractId } });
      const rows = workDayRows(dto);
      if (rows.length)
        await tx.contractWorkDay.createMany({
          data: rows.map((r) => ({ contractId, ...r })),
        });
      if (fields.status !== 'DRAFT')
        await tx.contractStatusHistory.create({
          data: {
            contractId,
            fromStatus: 'DRAFT',
            toStatus: fields.status,
            actor: 'ADMIN',
          },
        });
      return { contractId, staffMemberId: current.staffMemberId };
    });
  }

  /**
   * 임시저장 삭제. 발송한 적이 없어 남길 기록이 없다고 보고 행을 지운다(2026-10-12 결정) — 근무 요일 · 당사자 ·
   * 상태 이력 · 계약, 그리고 그 계약에만 쓰인 초안(가입 전) 직원 레코드. 임시저장이 아니면 409.
   * 계약 삭제는 상태를 조건으로 걸어, 읽은 뒤 초안 저장으로 넘어갔으면 0건 → 409 로 트랜잭션째 되돌린다.
   */
  async remove(contractId: number): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.contract.findUnique({
        where: { contractId },
        select: { status: true, staffMemberId: true },
      });
      if (!current) throw new NotFoundException('근로계약을 찾을 수 없습니다');
      if (current.status !== 'DRAFT')
        throw new ConflictException('임시저장한 근로계약서만 지울 수 있습니다');

      await tx.contractWorkDay.deleteMany({ where: { contractId } });
      await tx.contractParty.deleteMany({ where: { contractId } });
      await tx.contractStatusHistory.deleteMany({ where: { contractId } });
      const { count } = await tx.contract.deleteMany({
        where: { contractId, status: 'DRAFT' },
      });
      if (count === 0)
        throw new ConflictException('임시저장한 근로계약서만 지울 수 있습니다');

      const others = await tx.contract.count({
        where: { staffMemberId: current.staffMemberId },
      });
      if (others === 0)
        await tx.staffMember.deleteMany({
          where: { staffMemberId: current.staffMemberId, joinStatus: 'DRAFT' },
        });
    });
  }

  async list(query: ListContractsQueryDto): Promise<ContractListResponseDto> {
    const { page, pageSize, status, storeName, staffMemberName } = query;

    const where: Prisma.ContractWhereInput = {};
    if (status?.length) where.status = { in: status };
    if (staffMemberName)
      where.staffMember = {
        name: { contains: staffMemberName, mode: 'insensitive' },
      };
    // stores 는 1팀 테이블이라 Prisma 관계가 없다. 이름에 맞는 점포 id 를 먼저 구한다.
    if (storeName) {
      const stores = await this.prisma.store.findMany({
        where: { name: { contains: storeName, mode: 'insensitive' } },
        select: { storeId: true },
      });
      where.storeId = { in: stores.map((s) => s.storeId) };
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.contract.findMany({
        where,
        include: { staffMember: { select: { name: true } } },
        // 등록 시각이 같은 계약끼리 페이지를 넘나들지 않게 id 를 마지막에 둔다.
        orderBy: [{ createdAt: 'desc' }, { contractId: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.contract.count({ where }),
    ]);
    if (rows.length === 0) return { items: [], total };

    const stores = await this.prisma.store.findMany({
      where: { storeId: { in: [...new Set(rows.map((r) => r.storeId))] } },
      select: { storeId: true, name: true },
    });
    const storeNames = new Map(stores.map((s) => [s.storeId, s.name]));

    return {
      total,
      items: rows.map((r) => ({
        contractId: r.contractId,
        staffMemberId: r.staffMemberId,
        staffMemberName: r.staffMember.name,
        storeId: r.storeId,
        storeName: storeNames.get(r.storeId) ?? null,
        employmentType: r.employmentType,
        contractMethod: r.contractMethod,
        startDate: r.startDate ? isoDate(r.startDate) : null,
        endDate: r.endDate ? isoDate(r.endDate) : null,
        wageAmount: r.wageAmount,
        status: r.status,
        draftAction: r.draftAction,
        sentAt: r.sentAt?.toISOString() ?? null,
        signDeadlineAt: r.signDeadlineAt?.toISOString() ?? null,
      })),
    };
  }
}
