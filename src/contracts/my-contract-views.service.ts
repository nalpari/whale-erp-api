import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { dateOnly } from '../common/date-only';
import { PrismaService } from '../prisma/prisma.service';
import { storeNames } from '../payslips/payslip-shared';
import { article2Of, snapshotOf } from './contract-files.service';
import { contractArticles } from './contract-template';
import { CONTRACT_TERMS_SELECT, contractTermsOf } from './contract-terms';
import { employedOn, signDeadlinePassed } from './contract-status';
import type {
  MyContractDetailDto,
  MyContractListItemDto,
  MyContractListResponseDto,
} from './dto/my-contract-view.dto';
import { EMPTY_CONTRACT_IDENTITY, identityMismatches } from './identity-match';
import {
  MY_CONTRACT_NOT_FOUND,
  myContractWhere,
  myDocumentWhere,
} from './my-contract-scope';

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
  staffMember: {
    select: { employmentStatus: true, retiredDate: true, employmentType: true },
  },
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
        where: myContractWhere(accountId),
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
    // 기한이 없으면 뒤로(날인 대기). 처리 시각이 없으면(이력 없이 되돌린 계약) 발송 일시로 줄 세운다
    const deadline = (i: MyContractListItemDto) => i.signDeadlineAt ?? '9999';
    const recent = (i: MyContractListItemDto) =>
      i.processedAt ?? i.sentAt ?? '';
    items.sort(
      (a, b) =>
        Number(b.awaitingSignature) - Number(a.awaitingSignature) ||
        (a.awaitingSignature
          ? deadline(a).localeCompare(deadline(b))
          : recent(b).localeCompare(recent(a))) ||
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
        where: { contractId, ...myContractWhere(accountId) },
        select: {
          ...ITEM_SELECT,
          ...CONTRACT_TERMS_SELECT,
          jobTitle: true,
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
              employerName: true,
              employerCeoName: true,
              employerRegistrationNumber: true,
              employerAddress: true,
              employerAddressDetail: true,
              employerPhone: true,
              employerFixedAt: true,
              fixedWorkLocation: true,
              fixedJobTitle: true,
            },
          },
          staffMember: {
            select: {
              ...ITEM_SELECT.staffMember.select,
              jobTitle: true,
              name: true,
              phone: true,
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
      if (!c) return null;
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
      // 직원 필기 서명 · 보낸 원본은 싣지 않는다(myDocumentWhere)
      const documents = await tx.contractDocument.findMany({
        where: myDocumentWhere(contractId),
        select: { contractDocumentId: true, kind: true, fileName: true },
        orderBy: { contractDocumentId: 'asc' },
      });
      // where 의 staffMember.accountId 로 찾았으니 계정은 늘 있다
      return { c, account: c.staffMember.account!, store, documents };
    });
    if (!read) throw new NotFoundException(MY_CONTRACT_NOT_FOUND);
    const { c, account, store, documents } = read;
    // 계약 행이 점포를 외래키로 가리켜 없으면 데이터가 깨진 것이다(목록의 storeNames 와 같다)
    if (!store)
      throw new InternalServerErrorException(
        `점포 ${c.storeId} 를 찾을 수 없습니다.`,
      );

    const item = itemOf(c, store.name, now);
    const party = c.contractParty;
    // 날인 API(MyContractsService.checkSignable)와 같은 함수 · 같은 빈 값으로 대조한다
    const mismatches = identityMismatches(
      party ?? EMPTY_CONTRACT_IDENTITY,
      account,
    );
    const biz = store.businessProfile;
    const terms = contractTermsOf(c);
    // 당사자 행에 적힌 값(날인 때 고정 · 백필)이 있으면 사용자 칸 · 제2조를 그 값으로 — 처리 완료본과 같은 함수 · 같은 조건
    // (WHALEERP-131). 점포명 · 점포 주소 · 사업장 우편번호(고정하지 않는다 — 직원 앱이 보이지 않는다)는 지금 값이다
    const fixed = snapshotOf(party);
    const article2 = article2Of(c, store.name, fixed);
    // 직원 레코드 직무는 NOT NULL 이라 날인 · 백필이 적은 직무도 늘 있다 — 칸 타입(string)을 맞추려고만 잇는다
    const jobTitle = article2.jobTitle ?? c.staffMember.jobTitle;
    return {
      ...item,
      ...terms,
      // 보낸 원본 · 처리 완료본 PDF 와 같은 템플릿(WHALEERP-131)
      articles: contractArticles({
        ...terms,
        employmentType: c.employmentType,
        storeName: store.name,
        ...article2,
      }),
      signable: item.awaitingSignature && mismatches.length === 0,
      mismatches,
      worker: {
        // 당사자 행이 없는 옛 계약은 직원 레코드 값 — 관리자 상세와 같다(대조는 빈 계약서로 한다)
        name: party?.enteredName ?? c.staffMember.name,
        phone: party?.enteredPhone ?? c.staffMember.phone,
        birthDate: party?.enteredBirthDate
          ? dateOnly(party.enteredBirthDate)
          : null,
        gender: party?.enteredGender ?? null,
        isForeigner: party?.isForeigner ?? false,
        // 그 계약서에 적은 직무(WHALEERP-156) — 칸이 빈 옛 계약만 직원 레코드 값
        jobTitle,
        zipCode: party?.zipCode ?? null,
        address: party?.address ?? null,
        addressDetail: party?.addressDetail ?? null,
      },
      employer: {
        storeName: store.name,
        storePhone: fixed ? fixed.employerPhone : store.phone,
        storeZipCode: store.zipCode,
        storeAddress: store.address,
        storeAddressDetail: store.addressDetail,
        tradeName: fixed ? fixed.employerName : (biz?.bizTradeName ?? null),
        registrationNumber: fixed
          ? fixed.employerRegistrationNumber
          : (biz?.bizRegistrationNumber ?? null),
        ceoName: fixed ? fixed.employerCeoName : (biz?.bizCeoName ?? null),
        bizZipCode: biz?.bizZipCode ?? null,
        bizAddress: fixed ? fixed.employerAddress : (biz?.bizAddress ?? null),
        bizAddressDetail: fixed
          ? fixed.employerAddressDetail
          : (biz?.bizAddressDetail ?? null),
      },
      account: {
        name: account.realName,
        phone: account.phone,
        birthDate: dateOnly(account.birthDate),
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
    // 계약 사본(그 계약의 고용 형태). 비어 있는 옛 계약은 직원 레코드 값 — 관리자 상세의 원본
    employmentType: r.employmentType ?? r.staffMember.employmentType,
    contractMethod: r.contractMethod,
    startDate: dateOnly(r.startDate),
    endDate: dateOnly(r.endDate),
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
