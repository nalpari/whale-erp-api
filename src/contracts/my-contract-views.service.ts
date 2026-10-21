import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ContractStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { storeNames } from '../payslips/payslip-shared';
import {
  CONTRACT_TERMS_SELECT,
  contractTermsOf,
  isoDate,
} from './contract-terms';
import { signDeadlinePassed } from './contract-status';
import type {
  MyContractDetailDto,
  MyContractListItemDto,
  MyContractListResponseDto,
} from './dto/my-contract-view.dto';
import { EMPTY_CONTRACT_IDENTITY, identityMismatches } from './identity-match';
import { employedOn } from './my-contracts.service';

const CONTRACT_NOT_FOUND = '근로계약을 찾을 수 없습니다';

/** 직원에게 보이는 상태 — 임시저장 · 발송 대기는 아직 직원에게 간 계약이 아니다(목업 「발송 대기는 목록에 없다」) */
const VISIBLE: ContractStatus[] = [
  'PENDING_SIGNATURE',
  'CORRECTION_REQUESTED',
  'SIGNED',
  'REJECTED',
  'EXPIRED',
  'ENDED',
];

/** 내 계약 — 내 계정에 이어진 직원 레코드의 계약(후보 계정만 있는 소속 확인 대기 계약은 아니다) */
const mine = (accountId: number) =>
  ({
    status: { in: VISIBLE },
    staffMember: { accountId },
  }) satisfies Prisma.ContractWhereInput;

/** 목록 · 상세가 같이 읽는 칸 */
const ITEM_SELECT = {
  contractId: true,
  status: true,
  storeId: true,
  employmentType: true,
  contractMethod: true,
  startDate: true,
  endDate: true,
  sentAt: true,
  signDeadlineAt: true,
  // 지금 상태가 된 시각 — 마지막 이력 한 줄. 같은 시각이면 나중에 쓴 줄
  contractStatusHistories: {
    orderBy: [{ changedAt: 'desc' }, { contractStatusHistoryId: 'desc' }],
    take: 1,
    select: { toStatus: true, changedAt: true },
  },
  staffMember: { select: { employmentStatus: true, retiredDate: true } },
} satisfies Prisma.ContractSelect;

type ItemRow = Prisma.ContractGetPayload<{ select: typeof ITEM_SELECT }>;

/**
 * 직원 앱의 근로계약 목록 · 상세(WHALEERP-610). 직원 토큰만 — 컨트롤러가 막는다. 날인 · 거부 · 수정 요청은
 * MyContractsService(145)이고, 날인할 수 있는지 · 본인 대조는 그쪽과 같은 함수로 미리 보인다.
 * 남의 계약 · 소속 확인 대기 계약 · 임시저장 · 발송 대기는 없는 것과 같다(404, 목록에서 빠짐).
 */
@Injectable()
export class MyContractViewsService {
  constructor(private readonly prisma: PrismaService) {}

  /** 내 계약 전부(몇 건뿐이라 나누지 않는다). 날인을 기다리는 계약을 기한이 급한 순으로 먼저, 그다음 최근 것부터 */
  async list(
    accountId: number,
    now = new Date(),
  ): Promise<MyContractListResponseDto> {
    // 관계를 한 트랜잭션에서 차례로 읽는다 — 밖에서 읽으면 Prisma 가 동시에 보내 연결이 하나인 PGlite(e2e)가 끊는다
    const { rows, storeName } = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.contract.findMany({
        where: mine(accountId),
        select: ITEM_SELECT,
      });
      return {
        rows,
        storeName: await storeNames(
          tx,
          rows.map((r) => r.storeId),
        ),
      };
    });
    const items = rows.map((r) => itemOf(r, storeName(r.storeId), now));
    items.sort(
      (a, b) =>
        Number(b.awaitingSignature) - Number(a.awaitingSignature) ||
        (a.awaitingSignature
          ? (a.signDeadlineAt ?? '').localeCompare(b.signDeadlineAt ?? '')
          : (b.processedAt ?? '').localeCompare(a.processedAt ?? '')) ||
        b.contractId - a.contractId,
    );
    return { items, total: items.length };
  }

  /** 내 계약 상세 — 계약서에 그릴 값 · 사용자 칸 · 본인 대조 미리보기 */
  async findOne(
    accountId: number,
    contractId: number,
    now = new Date(),
  ): Promise<MyContractDetailDto> {
    const read = await this.prisma.$transaction(async (tx) => {
      const c = await tx.contract.findFirst({
        where: { contractId, ...mine(accountId) },
        select: {
          ...ITEM_SELECT,
          ...CONTRACT_TERMS_SELECT,
          contractParty: {
            select: {
              enteredName: true,
              enteredPhone: true,
              enteredBirthDate: true,
              enteredGender: true,
              isForeigner: true,
              zipCode: true,
              address: true,
              addressDetail: true,
            },
          },
          staffMember: {
            select: {
              ...ITEM_SELECT.staffMember.select,
              jobTitle: true,
              account: {
                select: {
                  realName: true,
                  phone: true,
                  birthDate: true,
                  gender: true,
                  isForeigner: true,
                  zipCode: true,
                  address: true,
                  addressDetail: true,
                },
              },
            },
          },
        },
      });
      if (!c?.staffMember.account) return null;
      // stores 는 1팀 테이블이라 계약과 Prisma 관계가 없다 — 따로 읽는다(지운 점포여도 보인다)
      const store = await tx.store.findUnique({
        where: { storeId: c.storeId },
        select: {
          name: true,
          phone: true,
          zipCode: true,
          address: true,
          addressDetail: true,
          businessProfile: {
            select: {
              bizTradeName: true,
              bizRegistrationNumber: true,
              bizCeoName: true,
              bizZipCode: true,
              bizAddress: true,
              bizAddressDetail: true,
            },
          },
        },
      });
      // 직원 필기 서명(SIGNATURE)은 처리 완료본(WHALEERP-131)의 재료라 싣지 않는다 — 관리자 상세와 같다
      const documents = await tx.contractDocument.findMany({
        where: { contractId, kind: { not: 'SIGNATURE' } },
        select: { contractDocumentId: true, kind: true, fileName: true },
        orderBy: { contractDocumentId: 'asc' },
      });
      return { c, account: c.staffMember.account, store, documents };
    });
    if (!read) throw new NotFoundException(CONTRACT_NOT_FOUND);
    const { c, account, store, documents } = read;
    // 계약 행이 점포를 외래키로 가리켜 없으면 데이터가 깨진 것이다(목록의 storeNames 와 같다)
    if (!store)
      throw new InternalServerErrorException(
        `점포 ${c.storeId} 를 찾을 수 없습니다`,
      );

    const item = itemOf(c, store.name, now);
    const party = c.contractParty;
    // 날인 API(MyContractsService.checkSignable)와 같은 함수 · 같은 빈 값으로 대조한다
    const mismatches = identityMismatches(
      party ?? EMPTY_CONTRACT_IDENTITY,
      account,
    );
    const biz = store.businessProfile;
    return {
      ...item,
      ...contractTermsOf(c),
      signable: item.awaitingSignature && mismatches.length === 0,
      mismatches,
      worker: {
        name: party?.enteredName ?? null,
        phone: party?.enteredPhone ?? null,
        birthDate: party?.enteredBirthDate
          ? isoDate(party.enteredBirthDate)
          : null,
        gender: party?.enteredGender ?? null,
        isForeigner: party?.isForeigner ?? false,
        jobTitle: c.staffMember.jobTitle,
        zipCode: party?.zipCode ?? null,
        address: party?.address ?? null,
        addressDetail: party?.addressDetail ?? null,
      },
      employer: {
        storeName: store.name,
        storePhone: store.phone,
        storeZipCode: store.zipCode,
        storeAddress: store.address,
        storeAddressDetail: store.addressDetail,
        tradeName: biz?.bizTradeName ?? null,
        registrationNumber: biz?.bizRegistrationNumber ?? null,
        ceoName: biz?.bizCeoName ?? null,
        bizZipCode: biz?.bizZipCode ?? null,
        bizAddress: biz?.bizAddress ?? null,
        bizAddressDetail: biz?.bizAddressDetail ?? null,
      },
      account: {
        name: account.realName,
        phone: account.phone,
        birthDate: isoDate(account.birthDate),
        gender: account.gender,
        isForeigner: account.isForeigner,
        zipCode: account.zipCode,
        address: account.address,
        addressDetail: account.addressDetail,
      },
      documents,
    };
  }
}

function itemOf(
  r: ItemRow,
  storeName: string,
  now: Date,
): MyContractListItemDto {
  // where 가 VISIBLE 로 거른다 — status 가 비어 있는 행은 오지 않는다
  const status = r.status!;
  const last = r.contractStatusHistories[0];
  return {
    contractId: r.contractId,
    status,
    storeId: r.storeId,
    storeName,
    employmentType: r.employmentType,
    contractMethod: r.contractMethod,
    startDate: r.startDate ? isoDate(r.startDate) : null,
    endDate: r.endDate ? isoDate(r.endDate) : null,
    sentAt: r.sentAt?.toISOString() ?? null,
    signDeadlineAt: r.signDeadlineAt?.toISOString() ?? null,
    // 서명 대기 그대로 다시 보내면(근로자 정보 수정 · 재발송) 이력이 쌓이지 않고 발송 일시만 바뀐다
    processedAt:
      status === 'PENDING_SIGNATURE'
        ? (r.sentAt?.toISOString() ?? null)
        : last && last.toStatus === status
          ? last.changedAt.toISOString()
          : null,
    // 날인 API 의 상태 · 기한 · 재직 확인과 같은 판정
    awaitingSignature:
      status === 'PENDING_SIGNATURE' &&
      !signDeadlinePassed(r, now) &&
      employedOn(r.staffMember, now),
  };
}
