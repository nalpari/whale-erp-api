import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import sharp from 'sharp';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE, requireStorage } from '../storage/storage.module';
import type { OptionalStorage } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { assertUpload } from '../storage/upload-check';
import {
  lockContract,
  rejectContract,
  requestCorrection,
  signContract,
  signDeadlineConflict,
  signDeadlinePassed,
  statusConflict,
} from './contract-status';
import type {
  MyContractActionResponseDto,
  SignedMyContractResponseDto,
} from './dto/my-contract-action.dto';
import { identityMismatches } from './identity-match';
import type { ContractIdentity } from './identity-match';

const CONTRACT_NOT_FOUND = '근로계약을 찾을 수 없습니다';
/** 필기 서명 이미지 상한 — 화면 캔버스 PNG 한 장 */
export const SIGNATURE_MAX_BYTES = 1024 * 1024;
/** 서명 이미지 가로 · 세로 상한(px) — 1MB 안에서도 큰 크기를 선언한 PNG 를 처리 완료본 합성(WHALEERP-131) 전에 막는다 */
export const SIGNATURE_MAX_PX = 4096;

/**
 * 서명 PNG 가 실제로 그려지는가 — 헤더(metadata)만이 아니라 픽셀까지 한 번 풀어 본다(stats). 가로 · 세로가 상한을 넘거나
 * 풀 수 없으면 400. 처리 완료본 합성(WHALEERP-131)은 이미 체결 완료 뒤라 그때 실패하면 되돌릴 수 없다.
 */
async function checkSignatureImage(buffer: Buffer): Promise<void> {
  const unreadable = () =>
    new BadRequestException('서명 이미지를 읽을 수 없습니다');
  const image = sharp(buffer, {
    limitInputPixels: SIGNATURE_MAX_PX * SIGNATURE_MAX_PX,
  });
  const { width, height } = await image.metadata().catch(() => {
    throw unreadable();
  });
  if (
    !width ||
    !height ||
    width > SIGNATURE_MAX_PX ||
    height > SIGNATURE_MAX_PX
  )
    throw new BadRequestException(
      `서명 이미지는 가로 · 세로 ${SIGNATURE_MAX_PX}px 까지입니다`,
    );
  await image.stats().catch(() => {
    throw unreadable();
  });
}

const EMPTY_PARTY: ContractIdentity = {
  enteredName: null,
  enteredPhone: null,
  enteredBirthDate: null,
  enteredGender: null,
  isForeigner: false,
};

/** 날인에 쓰는 내 계약 — 상태 · 기한 · 발송 일시와 대조할 계약서 값 · 계정 값 */
const MINE_SELECT = {
  status: true,
  sentAt: true,
  signDeadlineAt: true,
  contractParty: {
    select: {
      enteredName: true,
      enteredPhone: true,
      enteredBirthDate: true,
      enteredGender: true,
      isForeigner: true,
    },
  },
  staffMember: {
    select: {
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
} satisfies Prisma.ContractSelect;

/**
 * 직원 앱의 근로계약 날인 · 거부 · 수정 요청(WHALEERP-145). 직원 토큰만 — 컨트롤러가 막는다.
 * - 내 계약은 내 계정에 이어진 직원 레코드의 계약이다(임시저장 제외). 소속 추가 확인 · 복귀 확인을 기다리는 계약(후보 계정만
 *   있음)과 남의 계약은 없는 것과 같다(404, 같은 본문).
 * - 상태 전환 · 이력 · 기한 검사는 contract-status 의 함수가 한다(서명 대기에서만, 기한이 지났으면 409).
 * - 처리 완료본(서명을 합성한 PDF)은 WHALEERP-131 이 만든다. 여기서는 서명 이미지와 상태까지다.
 */
@Injectable()
export class MyContractsService {
  private readonly logger = new Logger(MyContractsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE) private readonly storage: OptionalStorage,
  ) {}

  /**
   * 날인. 계약서 값과 계정 값(이름 · 휴대전화번호 · 생년월일 · 성별 · 외국인 여부)이 같아야 받는다 — 다르면 409
   * IDENTITY_MISMATCH(다른 항목), 직원은 수정 요청을 낸다. 서명 PNG 는 트랜잭션 밖에서 먼저 올린다(올리는 동안 계약 행을
   * 쥐고 있지 않게). 잠근 뒤 다시 읽고 다시 대조한다 — 그사이 관리자가 근로자 정보를 고쳐 다시 보냈을 수 있다. 쓰기가
   * 실패하면 올린 서명을 지운다. 날인할 때 계정 주소를 계약 당사자 칸에 옮겨 고정한다(처리 완료본도 이 값을 쓴다).
   */
  async sign(
    accountId: number,
    contractId: number,
    signature: { buffer: Buffer; size: number } | undefined,
    sentAt?: string,
    now = new Date(),
  ): Promise<SignedMyContractResponseDto> {
    if (!signature)
      throw new BadRequestException('서명 이미지(signature)를 보내 주세요');
    // 형식은 DTO 가 보지만 주 표기(2026-W43)처럼 날짜로 못 바꾸는 값은 여기서 400 — 재발송(409)으로 보이지 않게
    if (sentAt !== undefined && Number.isNaN(Date.parse(sentAt)))
      throw new BadRequestException('발송 일시 형식이 아닙니다');
    // 남의 계약 · 상태 · 기한 · 대조가 틀린 요청은 저장소를 부르기 전에 막는다. 트랜잭션으로 묶는 건 Prisma 가 나눠 보내는
    // 관계 쿼리를 한 연결에서 차례로 보내려는 것이다(잠그지 않는다). 시점이 맞는지는 잠근 뒤 다시 대조하는 쪽이 맡는다
    this.checkSignable(
      await this.prisma.$transaction((tx) =>
        this.mine(tx, accountId, contractId),
      ),
      sentAt,
      now,
    );
    assertUpload(signature, ['PNG'], SIGNATURE_MAX_BYTES);
    await checkSignatureImage(signature.buffer);

    const storage = requireStorage(this.storage);
    const key = StorageService.newKey('contracts', contractId, 'PNG');
    try {
      await storage.put(key, signature.buffer, 'PNG');
    } catch (error) {
      this.logger.error(
        `서명 이미지 올리기 실패 contractId=${contractId} key=${key}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new ServiceUnavailableException(
        '서명을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요',
      );
    }
    let signedAt = now;
    try {
      await this.prisma.$transaction(async (tx) => {
        // 계약 행 하나만 잠근다 — 직원 행 · 번호 잠금을 이 뒤에 잡으면 퇴직 · 근로자 정보 수정과 순서가 엇갈린다
        await lockContract(tx, contractId);
        const c = await this.mine(tx, accountId, contractId);
        this.checkSignable(c, sentAt, now);
        await signContract(tx, contractId, now);
        // 응답의 날인 시각은 이력의 처리 시각(DB 시계)과 같게 — 처리 완료본(131)도 이 값을 읽는다
        signedAt = (
          await tx.contractStatusHistory.findFirstOrThrow({
            where: { contractId, toStatus: 'SIGNED' },
            orderBy: { contractStatusHistoryId: 'desc' },
            select: { changedAt: true },
          })
        ).changedAt;
        await tx.contractDocument.create({
          data: {
            contractId,
            kind: 'SIGNATURE',
            storageKey: key,
            fileName: `서명-${contractId}.png`,
            checksum: createHash('sha256')
              .update(signature.buffer)
              .digest('hex'),
          },
        });
        const account = c.staffMember.account!;
        await tx.contractParty.update({
          where: { contractId },
          data: {
            zipCode: account.zipCode,
            address: account.address,
            addressDetail: account.addressDetail,
            filledAt: now,
          },
        });
      });
    } catch (error) {
      // 커밋 응답 도중 연결이 끊긴 경우처럼 실제로는 커밋됐을 수도 있다 — 그때는 서명 행이 지운 키를 가리킨다(드묾)
      await storage
        .delete(key, { thumbnail: false })
        .catch((cause: unknown) =>
          this.logger.warn(
            `날인 실패 뒤 정리하지 못한 서명(커밋 여부를 확인할 것) contractId=${contractId} key=${key} (${
              cause instanceof Error ? cause.message : String(cause)
            })`,
          ),
        );
      throw error;
    }
    return { contractId, status: 'SIGNED', signedAt };
  }

  /** 거부 — 사유는 선택이다. 서명 대기 · 기한 안에서만 */
  async reject(
    accountId: number,
    contractId: number,
    reason?: string,
    now = new Date(),
  ): Promise<MyContractActionResponseDto> {
    await this.prisma.$transaction(async (tx) => {
      await this.mine(tx, accountId, contractId);
      await rejectContract(tx, contractId, reason, now);
    });
    return { contractId, status: 'REJECTED' };
  }

  /** 수정 요청 — 대조 결과와 상관없이 서명 대기 · 기한 안이면 받는다(2026-10-21 김민식). 따로 받는 내용은 없다 */
  async requestCorrection(
    accountId: number,
    contractId: number,
    now = new Date(),
  ): Promise<MyContractActionResponseDto> {
    await this.prisma.$transaction(async (tx) => {
      await this.mine(tx, accountId, contractId);
      await requestCorrection(tx, contractId, now);
    });
    return { contractId, status: 'CORRECTION_REQUESTED' };
  }

  /** 내 계약 — 내 계정에 이어진 직원 레코드의 계약(임시저장 제외). 아니면 404 */
  private async mine(
    db: Prisma.TransactionClient,
    accountId: number,
    contractId: number,
  ) {
    const c = await db.contract.findFirst({
      where: {
        contractId,
        status: { not: 'DRAFT' },
        staffMember: { accountId },
      },
      select: MINE_SELECT,
    });
    if (!c?.staffMember.account)
      throw new NotFoundException(CONTRACT_NOT_FOUND);
    return c;
  }

  /** 서명 대기 · 기한 안 · 같은 발송 · 본인 대조 — 아니면 409 */
  private checkSignable(
    c: Prisma.ContractGetPayload<{ select: typeof MINE_SELECT }>,
    sentAt: string | undefined,
    now: Date,
  ): void {
    if (c.status !== 'PENDING_SIGNATURE')
      throw statusConflict(c.status ?? 'PENDING_SEND');
    if (signDeadlinePassed(c, now)) throw signDeadlineConflict();
    if (
      sentAt !== undefined &&
      c.sentAt?.getTime() !== new Date(sentAt).getTime()
    )
      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        code: 'CONTRACT_RESENT',
        message:
          '근로계약서가 다시 발송됐습니다. 새로 고쳐 바뀐 계약서를 확인해 주세요',
      });
    // 당사자 행이 없으면 모든 칸이 빈 계약서로 대조한다 — 계정 성별이 비었을 때 성별을 보지 않는 규칙도 그대로다
    const mismatches = identityMismatches(
      c.contractParty ?? EMPTY_PARTY,
      c.staffMember.account!,
    );
    if (mismatches.length)
      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        code: 'IDENTITY_MISMATCH',
        message:
          '계약서의 직원 정보가 가입한 정보와 다릅니다. 수정을 요청해 주세요',
        mismatches,
      });
  }
}
