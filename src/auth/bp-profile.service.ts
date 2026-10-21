import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BusinessVerificationService } from '../admin-signup/business-verification.service';
import { sameMillisecond } from '../common/updated-at';
import { PrismaService } from '../prisma/prisma.service';
import type { BpBusinessVerificationDto } from './dto/bp-business-verification.dto';
import type { BpProfileUpdateDto } from './dto/bp-profile-update.dto';
import type { BpProfileResponseDto } from './dto/bp-profile.response.dto';

type Tx = Prisma.TransactionClient;
const NOT_FOUND = '관리자 계정을 찾을 수 없습니다';
const NOT_BP_MASTER = 'BP 마스터만 사업자정보를 볼 수 있습니다';
const BP_MASTER = 'BM';

type History = {
  field: string;
  beforeValue: string | null;
  afterValue: string | null;
};

/**
 * 내 정보(MY PAGE) 사업자정보 조회 · 수정 · 인증(manyfast F-AMTDCK > S-UOJVUR). BP 마스터 본인의
 * bp_codes 행만 다룬다 — 다른 BP 는 다루지 않는다(플랫폼 쪽 BP 수정은 F-EHHJLV, 아직 없음).
 * 사업자등록번호 · 대표자명 · 개업일자는 사업자 번호 인증으로만 바뀐다 — 바로 수정할 수 없다.
 */
@Injectable()
export class BpProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly verifier: BusinessVerificationService,
  ) {}

  async get(adminAccountId: number): Promise<BpProfileResponseDto> {
    const bp = await this.findBp(this.prisma, adminAccountId);
    return this.toDto(bp);
  }

  /**
   * 바로 고칠 수 있는 항목만 저장한다(상호명 · 대표자 연락처 · 대표자 이메일 · 사업장주소 · 업태 · 종목).
   * 동시 수정은 updatedAt 으로 가린다 — admin-profile.service.ts 의 update 와 같은 패턴.
   */
  async update(
    adminAccountId: number,
    input: BpProfileUpdateDto,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const { bpCodeId, bp: target } = await this.findBpForUpdate(
        tx,
        adminAccountId,
      );

      const data = {
        tradeName: input.tradeName,
        bizCeoPhone: input.bizCeoPhone ?? null,
        bizCeoEmail: input.bizCeoEmail ?? null,
        bizZipCode: input.bizZipCode ?? null,
        bizAddress: input.bizAddress ?? null,
        bizAddressDetail: input.bizAddressDetail ?? null,
        bizCategory: input.bizCategory ?? null,
        bizItem: input.bizItem ?? null,
      };

      const { count } = await tx.bpCode.updateMany({
        where: { bpCodeId, updatedAt: sameMillisecond(input.updatedAt) },
        data: { ...data, updatedBy: adminAccountId },
      });
      if (count === 0)
        throw new ConflictException(
          '다른 곳에서 먼저 수정했습니다. 최신 정보를 불러온 뒤 다시 저장해 주세요',
        );

      const changes = [
        change('상호명', target.tradeName, data.tradeName),
        change('대표자 연락처', target.bizCeoPhone, data.bizCeoPhone),
        change('대표자 이메일', target.bizCeoEmail, data.bizCeoEmail),
        change('사업장 우편번호', target.bizZipCode, data.bizZipCode),
        change('사업장 기본주소', target.bizAddress, data.bizAddress),
        change(
          '사업장 상세주소',
          target.bizAddressDetail,
          data.bizAddressDetail,
        ),
        change('업태', target.bizCategory, data.bizCategory),
        change('종목', target.bizItem, data.bizItem),
      ].filter((c): c is History => c !== null);
      if (changes.length)
        await tx.bpChangeHistory.createMany({
          data: changes.map((c) => ({
            bpCodeId,
            ...c,
            changedBy: adminAccountId,
          })),
        });
    });
  }

  /**
   * 사업자 번호 인증(최초 · 재인증 공통). BusinessVerificationService 가 중복 확인(다른 BP · 점포) →
   * 국세청 진위확인 순서로 본다 — 가입과 같은 서비스를 그대로 쓴다. 성공하면 받은 토큰은 버리고(여기는
   * 이미 있는 BP 행에 바로 반영해도 된다 — 가입처럼 계정이 없어 토큰에 담아 들고 다닐 필요가 없다)
   * 사업자등록번호 · 대표자명 · 개업일자와 인증일시를 저장한다.
   */
  async verifyBusiness(
    adminAccountId: number,
    input: BpBusinessVerificationDto,
  ): Promise<BpProfileResponseDto> {
    await this.verifier.verify({
      bizRegistrationNumber: input.bizRegistrationNumber,
      bizCeoName: input.bizCeoName,
      bizOpenDate: input.bizOpenDate,
    });

    return this.prisma.$transaction(async (tx) => {
      const { bpCodeId, bp: target } = await this.findBpForUpdate(
        tx,
        adminAccountId,
      );
      const verifiedAt = new Date();
      const openDate = new Date(`${input.bizOpenDate}T00:00:00.000Z`);

      const { count } = await tx.bpCode.updateMany({
        where: { bpCodeId, updatedAt: sameMillisecond(input.updatedAt) },
        data: {
          bizRegistrationNumber: input.bizRegistrationNumber,
          bizCeoName: input.bizCeoName,
          bizOpenDate: openDate,
          bizVerifiedAt: verifiedAt,
          updatedBy: adminAccountId,
        },
      });
      if (count === 0)
        throw new ConflictException(
          '다른 곳에서 먼저 수정했습니다. 최신 정보를 불러온 뒤 다시 시도해 주세요',
        );

      const changes = [
        change(
          '사업자등록번호',
          target.bizRegistrationNumber,
          input.bizRegistrationNumber,
        ),
        change('대표자명', target.bizCeoName, input.bizCeoName),
        change('개업일자', dateOnly(target.bizOpenDate), dateOnly(openDate)),
      ].filter((c): c is History => c !== null);
      await tx.bpChangeHistory.createMany({
        data: changes.map((c) => ({
          bpCodeId,
          ...c,
          changedBy: adminAccountId,
          note: '사업자 번호 인증',
        })),
      });

      const saved = await tx.bpCode.findFirstOrThrow({
        where: { bpCodeId },
      });
      return this.toDto(saved);
    });
  }

  /** 로그인한 관리자가 BP 마스터인지 보고, 그 BP 행을 돌려준다. */
  private async findBp(
    db: Tx | PrismaService,
    adminAccountId: number,
  ): Promise<BpCodeRow> {
    const account = await db.adminAccount.findFirst({
      where: { adminAccountId, isDeleted: false },
      select: { roleTypeCode: true, bpCodeId: true },
    });
    if (!account) throw new NotFoundException(NOT_FOUND);
    if (account.roleTypeCode !== BP_MASTER)
      throw new ForbiddenException(NOT_BP_MASTER);

    const bp = await db.bpCode.findFirst({
      where: { bpCodeId: account.bpCodeId, isDeleted: false },
    });
    if (!bp) throw new NotFoundException(NOT_FOUND);
    return bp;
  }

  private async findBpForUpdate(tx: Tx, adminAccountId: number) {
    const bp = await this.findBp(tx, adminAccountId);
    return { bpCodeId: bp.bpCodeId, bp };
  }

  private toDto(bp: BpCodeRow): BpProfileResponseDto {
    return {
      tradeName: bp.tradeName,
      bizRegistrationNumber: bp.bizRegistrationNumber ?? '',
      bizCeoName: bp.bizCeoName ?? '',
      bizOpenDate: dateOnly(bp.bizOpenDate),
      bizCeoPhone: bp.bizCeoPhone ?? '',
      bizCeoEmail: bp.bizCeoEmail ?? '',
      bizZipCode: bp.bizZipCode ?? '',
      bizAddress: bp.bizAddress ?? '',
      bizAddressDetail: bp.bizAddressDetail ?? '',
      bizCategory: bp.bizCategory ?? '',
      bizItem: bp.bizItem ?? '',
      bizVerifiedAt: bp.bizVerifiedAt,
      updatedAt: bp.updatedAt,
    };
  }
}

type BpCodeRow = {
  bpCodeId: number;
  tradeName: string;
  bizRegistrationNumber: string | null;
  bizCeoName: string | null;
  bizOpenDate: Date | null;
  bizCeoPhone: string | null;
  bizCeoEmail: string | null;
  bizZipCode: string | null;
  bizAddress: string | null;
  bizAddressDetail: string | null;
  bizCategory: string | null;
  bizItem: string | null;
  bizVerifiedAt: Date | null;
  updatedAt: Date;
};

function dateOnly(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function change(
  field: string,
  beforeValue: string | null,
  afterValue: string | null,
): History | null {
  return beforeValue === afterValue ? null : { field, beforeValue, afterValue };
}
