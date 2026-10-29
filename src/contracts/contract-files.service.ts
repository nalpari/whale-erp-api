import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { dateOnly } from '../common/date-only';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE, type OptionalStorage } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  type ContractPdfInput,
  type ContractPdfKind,
  contractPdfFileName,
  contractPdfModel,
  renderContractPdf,
} from './contract-pdf';
import { contractArticles, contractHeading } from './contract-template';
import { CONTRACT_TERMS_SELECT, contractTermsOf } from './contract-terms';

/** 배치가 보낸 원본을 다시 만들어 보는 범위 — 발송 뒤 이만큼 지난 것부터(보내기 · 되돌리기가 끝난 뒤) */
export const SENT_ORIGINAL_GRACE_MS = 5 * 60_000;
/** 배치가 보낸 원본을 다시 만들어 보는 범위 — 발송 뒤 하루 안의 것만. 그보다 오래된 발송은 그때의 점포 정보를 알 수 없어 만들지 않는다 */
export const SENT_ORIGINAL_RETRY_MS = 24 * 60 * 60_000;
/** 배치 한 번에 만드는 파일 수 — PDF 는 한 장에 수백 ms 라 10분 주기 안에 끝나게 둔다 */
export const FILL_BATCH_SIZE = 50;

export type MakeResult = 'CREATED' | 'EXISTS' | 'SKIPPED';

/** 보낸 원본 · 처리 완료본을 그리는 데 읽는 계약 값 */
const SOURCE_SELECT = {
  ...CONTRACT_TERMS_SELECT,
  employmentType: true,
  workLocation: true,
  jobTitle: true,
  storeId: true,
  sentAt: true,
  contractMethod: true,
  staffMember: { select: { name: true, phone: true, jobTitle: true } },
  contractParty: {
    select: {
      enteredName: true,
      enteredPhone: true,
      enteredBirthDate: true,
      address: true,
      addressDetail: true,
      employerName: true,
      employerCeoName: true,
      employerRegistrationNumber: true,
      employerAddress: true,
      employerAddressDetail: true,
      employerPhone: true,
      employerFixedAt: true,
    },
  },
} satisfies Prisma.ContractSelect;

/** 점포 정보 — 날인 때 고정하는 사용자 칸(MyContractsService.sign)도 이 select 로 읽는다 */
export const EMPLOYER_STORE_SELECT = {
  name: true,
  phone: true,
  businessProfile: {
    select: {
      bizTradeName: true,
      bizRegistrationNumber: true,
      bizCeoName: true,
      bizAddress: true,
      bizAddressDetail: true,
    },
  },
} satisfies Prisma.StoreSelect;

type EmployerStore = Prisma.StoreGetPayload<{
  select: typeof EMPLOYER_STORE_SELECT;
}>;

/** 점포 정보 → 사용자 칸. 상호가 없으면 점포명, 소재지는 사업자 주소, 전화번호는 점포 연락처(직원 앱 상세와 같은 칸) */
export const employerOf = (store: EmployerStore) => ({
  name: store.businessProfile?.bizTradeName ?? store.name,
  ceoName: store.businessProfile?.bizCeoName ?? null,
  registrationNumber: store.businessProfile?.bizRegistrationNumber ?? null,
  address: store.businessProfile?.bizAddress ?? null,
  addressDetail: store.businessProfile?.bizAddressDetail ?? null,
  phone: store.phone,
});

export type ContractFileSource = {
  contract: Prisma.ContractGetPayload<{ select: typeof SOURCE_SELECT }> & {
    contractId: number;
  };
  store: EmployerStore;
  signedAt: Date | null;
};

/**
 * 읽은 값 → PDF 칸. 처리 완료본의 사용자 칸은 날인 때 고정한 값이고, 고정 전에 체결된 계약(employer_fixed_at NULL)과 보낸
 * 원본은 지금 점포 정보다(WHALEERP-131, 2026-10-29 김민식). 근로자 칸은 계약서 값 — 주소는 날인 때 고정한 값이라 보낸 원본에는
 * 보통 없다.
 */
export function pdfInputOf(
  kind: ContractPdfKind,
  { contract: c, store, signedAt }: ContractFileSource,
): ContractPdfInput & { employerFixed: boolean } {
  const party = c.contractParty;
  const fixed = kind === 'SIGNED_COPY' && !!party?.employerFixedAt;
  return {
    kind,
    contractId: c.contractId,
    heading: contractHeading(c.employmentType),
    articles: contractArticles({
      ...contractTermsOf(c),
      employmentType: c.employmentType,
      storeName: store.name,
      workLocation: c.workLocation,
      jobTitle: c.jobTitle ?? c.staffMember.jobTitle,
    }),
    employer: fixed
      ? {
          name: party.employerName ?? store.name,
          ceoName: party.employerCeoName,
          registrationNumber: party.employerRegistrationNumber,
          address: party.employerAddress,
          addressDetail: party.employerAddressDetail,
          phone: party.employerPhone,
        }
      : employerOf(store),
    worker: {
      name: party?.enteredName ?? c.staffMember.name,
      birthDate: party?.enteredBirthDate
        ? dateOnly(party.enteredBirthDate)
        : null,
      address: party?.address ?? null,
      addressDetail: party?.addressDetail ?? null,
      phone: party?.enteredPhone ?? c.staffMember.phone,
    },
    sentAt: c.sentAt!,
    signedAt,
    employerFixed: fixed,
  };
}

const isUniqueViolation = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/**
 * 근로계약서 보낸 원본(SENT_ORIGINAL) · 처리 완료본(SIGNED_COPY) 만들기(WHALEERP-131). 조항은 직원 앱 화면과 같은 템플릿이다.
 * - 보낸 원본은 발송마다 한 장(contract_documents.sent_at = 계약의 발송 일시), 처리 완료본은 계약마다 한 장 — 고유 인덱스가 막아
 *   날인 직후 호출과 채우기 배치가 함께 만들어도 하나만 남는다(진 쪽은 올린 파일을 지운다).
 * - 처리 완료본은 직원 필기 서명(SIGNATURE)을 합성한다. 서명이 없으면(종이 계약 · 날인 전) 만들지 않는다. 종이 계약은 본문을
 *   그리지 않으니 보낸 원본도 없다.
 * - 저장 · 응답 흐름(날인 · 발송)은 기다리지 않는다 — 커밋 뒤 afterSigned · afterSent 로 부르고, 실패하면 로그만 남긴다. 놓친
 *   것은 채우기 배치(ContractFilesScheduler)가 다시 만든다. 체결 완료인데 완료본이 없는 계약(날인이 먼저 나가 생긴 것)도 같은
 *   배치가 채운다.
 */
@Injectable()
export class ContractFilesService {
  private readonly logger = new Logger(ContractFilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE) private readonly storage: OptionalStorage,
  ) {}

  /** 날인 커밋 뒤 — 기다리지 않는다 */
  afterSigned(contractId: number): void {
    this.background('SIGNED_COPY', contractId);
  }

  /** 발송 · 재발송이 나간 뒤 — 기다리지 않는다 */
  afterSent(contractId: number): void {
    this.background('SENT_ORIGINAL', contractId);
  }

  private background(kind: ContractPdfKind, contractId: number): void {
    if (!this.storage) return;
    this.make(kind, contractId).catch((e: unknown) =>
      this.logger.error(
        `${kind} 만들기 실패 contract=${contractId} — 채우기 배치가 다시 만든다`,
        e instanceof Error ? e.stack : String(e),
      ),
    );
  }

  /**
   * 채우기 배치 — 처리 완료본이 없는 체결 계약(서명 있음)과, 발송 뒤 하루 안인데 그 발송의 보낸 원본이 없는 계약을 만든다. 한
   * 건이 실패해도 나머지는 만든다. 만든 수를 돌려준다.
   */
  async fillMissing(now = new Date()): Promise<number> {
    if (!this.storage) return 0;
    const signed = await this.prisma.contract.findMany({
      where: {
        NOT: { contractMethod: 'PAPER' },
        sentAt: { not: null },
        contractDocuments: {
          some: { kind: 'SIGNATURE' },
          none: { kind: 'SIGNED_COPY' },
        },
      },
      select: { contractId: true },
      orderBy: { contractId: 'asc' },
      take: FILL_BATCH_SIZE,
    });
    // 「그 발송의 원본」은 두 테이블의 시각을 맞대야 해 Prisma 조건으로 쓸 수 없다
    const sent = await this.prisma.$queryRaw<{ contract_id: number }[]>`
      SELECT c."contract_id" FROM "contracts" c
      WHERE c."sent_at" BETWEEN ${new Date(now.getTime() - SENT_ORIGINAL_RETRY_MS)}
                            AND ${new Date(now.getTime() - SENT_ORIGINAL_GRACE_MS)}
        AND c."contract_method" IS DISTINCT FROM 'PAPER'
        AND NOT EXISTS (
          SELECT 1 FROM "contract_documents" d
          WHERE d."contract_id" = c."contract_id" AND d."kind" = 'SENT_ORIGINAL' AND d."sent_at" = c."sent_at")
      ORDER BY c."contract_id" LIMIT ${FILL_BATCH_SIZE}`;
    let made = 0;
    const jobs: [ContractPdfKind, number][] = [
      ...signed.map((c): [ContractPdfKind, number] => [
        'SIGNED_COPY',
        c.contractId,
      ]),
      ...sent.map((c): [ContractPdfKind, number] => [
        'SENT_ORIGINAL',
        c.contract_id,
      ]),
    ];
    for (const [kind, contractId] of jobs) {
      const result = await this.make(kind, contractId).catch((e: unknown) => {
        this.logger.error(
          `${kind} 채우기 실패 contract=${contractId}`,
          e instanceof Error ? e.stack : String(e),
        );
        return 'SKIPPED' as const;
      });
      if (result === 'CREATED') made += 1;
    }
    return made;
  }

  /** 그 계약의 보낸 원본(지금 발송분) · 처리 완료본을 만든다. 이미 있으면 EXISTS, 만들 수 없는 계약이면 SKIPPED */
  async make(kind: ContractPdfKind, contractId: number): Promise<MakeResult> {
    // 조항 · 발송 일시 · 파일 목록을 한 시점으로 읽는다 — 그사이 다시 보낸 계약의 새 조항이 옛 발송 일시로 남지 않게
    const read = await this.prisma.$transaction(
      async (tx) => {
        const contract = await tx.contract.findUnique({
          where: { contractId },
          select: SOURCE_SELECT,
        });
        if (!contract) return null;
        // 한 트랜잭션 연결에서 차례로 읽는다(동시에 보내지 않는다)
        const store = await tx.store.findUnique({
          where: { storeId: contract.storeId },
          select: EMPLOYER_STORE_SELECT,
        });
        const documents = await tx.contractDocument.findMany({
          where: { contractId, kind: { in: ['SIGNATURE', kind] } },
          select: { kind: true, storageKey: true, sentAt: true },
          orderBy: { contractDocumentId: 'desc' },
        });
        const signed = await tx.contractStatusHistory.findFirst({
          where: { contractId, toStatus: 'SIGNED' },
          orderBy: { contractStatusHistoryId: 'desc' },
          select: { changedAt: true },
        });
        return { contract, store, documents, signedAt: signed?.changedAt };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    if (!read || !read.store) return 'SKIPPED';
    const { contract, store, documents } = read;
    const sentAt = contract.sentAt;
    if (contract.contractMethod === 'PAPER' || !sentAt) return 'SKIPPED';
    const signature = documents.find((d) => d.kind === 'SIGNATURE');
    if (kind === 'SIGNED_COPY' && !signature) return 'SKIPPED';
    if (
      documents.some(
        (d) =>
          d.kind === kind &&
          (kind === 'SIGNED_COPY' || d.sentAt?.getTime() === sentAt.getTime()),
      )
    )
      return 'EXISTS';

    const storage = this.storage;
    if (!storage) return 'SKIPPED';
    const input = pdfInputOf(kind, {
      contract: { ...contract, contractId },
      store,
      signedAt: read.signedAt ?? null,
    });
    if (kind === 'SIGNED_COPY' && !input.employerFixed)
      this.logger.warn(
        `처리 완료본 사용자 칸을 날인 시점 값이 없어 지금 점포 정보로 만든다 contract=${contractId}`,
      );
    const pdf = await renderContractPdf(
      contractPdfModel(input),
      signature ? await storage.get(signature.storageKey) : null,
    );
    const key = StorageService.newKey('contracts', contractId, 'PDF');
    await storage.put(key, pdf, 'PDF');
    try {
      await this.prisma.contractDocument.create({
        data: {
          contractId,
          kind,
          storageKey: key,
          fileName: contractPdfFileName({ kind, contractId, sentAt }),
          checksum: createHash('sha256').update(pdf).digest('hex'),
          sentAt,
        },
      });
      return 'CREATED';
    } catch (error) {
      // 커밋 응답이 끊겨 실제로는 들어갔을 수 있다 — 행이 이 키를 가리키면(또는 확인할 수 없으면) 파일을 남긴다(날인과 같다)
      const kept = await this.prisma.contractDocument
        .findFirst({ where: { storageKey: key }, select: { kind: true } })
        .then(
          (row) => row !== null,
          () => true,
        );
      if (!kept)
        await storage
          .delete(key)
          .catch((e: unknown) =>
            this.logger.error(
              `쓰지 않은 ${kind} 파일 지우기 실패 contract=${contractId} key=${key}`,
              e instanceof Error ? e.stack : String(e),
            ),
          );
      // 다른 실행이 먼저 만들었다
      if (isUniqueViolation(error)) return 'EXISTS';
      throw error;
    }
  }
}
