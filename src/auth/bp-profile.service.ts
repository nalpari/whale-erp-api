import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  BusinessVerificationService,
  DUPLICATE_BIZ_REGISTRATION_NUMBER,
} from '../admin-signup/business-verification.service';
import { sameMillisecond } from '../common/updated-at';
import { PrismaService } from '../prisma/prisma.service';
import type { BpBusinessVerificationDto } from './dto/bp-business-verification.dto';
import type { BpBusinessVerificationResponseDto } from './dto/bp-business-verification.response.dto';
import type { BpProfileUpdateDto } from './dto/bp-profile-update.dto';
import type { BpProfileResponseDto } from './dto/bp-profile.response.dto';

type Tx = Prisma.TransactionClient;
const NOT_FOUND = '관리자 계정을 찾을 수 없습니다.';
const NOT_BP_MASTER = 'BP 마스터만 사업자정보를 볼 수 있습니다.';
const BP_MASTER = 'BM';
// 국세청 키 · 하루 할당량은 가입 · 점포 · 마이페이지가 함께 쓴다 — 점포(StoreManagementService
// .countNtsCall)와 같은 한도를 관리자별로 따로 센다(코드 리뷰로 찾음, 2026-10-22 — 점포에만 있던
// 보호가 여기엔 없었다). 컨트롤러의 @Throttle 은 호출 자체를 막는다. BusinessVerificationService
// .verify() 가 중복 확인과 국세청 호출을 한 메서드 안에서 같이 하므로, 점포처럼 국세청 호출 직전이
// 아니라 인증 시도마다(중복으로 거절된 시도 포함) 센다 — 더 보수적일 뿐 할당량 보호에는 문제없다.
const NTS_CALLS_PER_HOUR = 10;
const NTS_WINDOW_MS = 3_600_000;

type History = {
  field: string;
  beforeValue: string | null;
  afterValue: string | null;
};

/**
 * 내 정보(마이페이지) 사업자정보 조회 · 수정 · 인증(manyfast F-AMTDCK > S-UOJVUR). BP 마스터 본인의
 * bp_codes 행만 다룬다 — 다른 BP 는 다루지 않는다(플랫폼 쪽 BP 수정은 F-EHHJLV, 아직 없음).
 *
 * 사업자등록번호 · 대표자명 · 개업일자는 점포 사업자정보와 같은 두 단계다(2026-10-22 사용자 결정 —
 * 「인증하기」를 누르자마자 바로 저장되던 것을 고침): business-verification 은 검사만 하고 10분짜리
 * 토큰을 돌려주며, 실제로 반영되는 것은 그 토큰을 실어 보낸 update(저장) 뿐이다. 화면이 보낸 번호 ·
 * 대표자명 · 개업일자 값은 믿지 않는다 — 토큰 안의 값만 쓴다(admin-signup.service.ts 의 signup 과 같다).
 * update 의 clearBusinessVerification 은 점포와 달리 그 세 값과 인증일시를 아예 지운다(2026-10-23
 * 사용자 결정) — businessVerificationToken 과는 함께 올 수 없다.
 */
@Injectable()
export class BpProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly verifier: BusinessVerificationService,
  ) {}

  /** 관리자별 국세청 호출 시각(ms). NTS_CALLS_PER_HOUR 에 쓴다. 프로세스 메모리라 인스턴스마다 따로 센다. */
  private readonly ntsCallsAt = new Map<number, number[]>();

  async get(adminAccountId: number): Promise<BpProfileResponseDto> {
    const bp = await this.findBp(this.prisma, adminAccountId);
    return this.toDto(bp);
  }

  /**
   * 사업자 번호 인증 — 검사만(최초 · 재인증 공통). BusinessVerificationService 가 중복 확인(다른 BP ·
   * 점포, 이 BP 자신은 중복으로 보지 않는다) → 국세청 진위확인 순서로 본다 — 가입과 같은 서비스를 그대로
   * 쓴다. 저장은 하지 않는다 — 받은 토큰을 update 에 실어야 반영된다.
   */
  async requestVerification(
    adminAccountId: number,
    input: BpBusinessVerificationDto,
  ): Promise<BpBusinessVerificationResponseDto> {
    const bp = await this.findBp(this.prisma, adminAccountId);
    this.countNtsCall(adminAccountId);
    const verificationToken = await this.verifier.verify(
      {
        bizRegistrationNumber: input.bizRegistrationNumber,
        bizCeoName: input.bizCeoName,
        bizOpenDate: input.bizOpenDate,
      },
      bp.bpCodeId,
    );
    return { verificationToken };
  }

  /**
   * 바로 고칠 수 있는 항목(상호명 · 대표자 연락처 · 대표자 이메일 · 사업장주소 · 업태 · 종목)을 저장한다.
   * businessVerificationToken 을 실었으면 그 토큰 안의 사업자등록번호 · 대표자명 · 개업일자와 인증일시도
   * 같은 트랜잭션에서 함께 반영한다 — 토큰과 저장 사이에 다른 BP·점포가 같은 번호로 먼저 들어왔을 수
   * 있어 advisory lock 으로 번호별 줄을 서고(점포 저장 · 가입과 같은 키), 쓰기 직전 중복을 한 번 더
   * 본다(admin-signup.service.ts 의 signup 과 같은 안전장치). 동시 수정은 updatedAt 으로 가린다.
   * clearBusinessVerification 을 true 로 보내면 그 네 칸을 대신 지운다 — businessVerificationToken 과
   * 함께 오면 400.
   */
  async update(
    adminAccountId: number,
    input: BpProfileUpdateDto,
  ): Promise<void> {
    if (input.businessVerificationToken && input.clearBusinessVerification)
      throw new BadRequestException(
        '사업자정보를 새로 반영하는 것과 지우는 것을 함께 요청할 수 없습니다.',
      );
    const biz = input.businessVerificationToken
      ? await this.verifier.readToken(input.businessVerificationToken)
      : null;

    await this.prisma.$transaction(async (tx) => {
      const { bpCodeId, bp: target } = await this.findBpForUpdate(
        tx,
        adminAccountId,
      );

      if (biz) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`stores:biz:${biz.bizRegistrationNumber}`}))`;
        if (
          await this.verifier.isBizRegistrationNumberTaken(
            biz.bizRegistrationNumber,
            tx,
            bpCodeId,
          )
        )
          throw new ConflictException(DUPLICATE_BIZ_REGISTRATION_NUMBER);
      }

      const clear = Boolean(input.clearBusinessVerification);
      const data = {
        tradeName: input.tradeName,
        bizCeoPhone: input.bizCeoPhone ?? null,
        bizCeoEmail: input.bizCeoEmail ?? null,
        bizZipCode: input.bizZipCode ?? null,
        bizAddress: input.bizAddress ?? null,
        bizAddressDetail: input.bizAddressDetail ?? null,
        bizCategory: input.bizCategory ?? null,
        bizItem: input.bizItem ?? null,
        ...(biz && {
          bizRegistrationNumber: biz.bizRegistrationNumber,
          bizCeoName: biz.bizCeoName,
          bizOpenDate: new Date(`${biz.bizOpenDate}T00:00:00.000Z`),
          bizVerifiedAt: new Date(),
        }),
        // clearBusinessVerification — 점포와 달리 BP 자신의 사업자정보는 지울 수 있다(2026-10-23 사용자
        // 결정). 구독 기록이 있으면 막아야 하지만 구독 자체가 아직 없어 지금은 검사하지 않는다(DTO 주석 참고).
        ...(clear && {
          bizRegistrationNumber: null,
          bizCeoName: null,
          bizOpenDate: null,
          bizVerifiedAt: null,
        }),
      };

      const { count } = await tx.bpCode.updateMany({
        where: { bpCodeId, updatedAt: sameMillisecond(input.updatedAt) },
        data: { ...data, updatedBy: adminAccountId },
      });
      if (count === 0)
        throw new ConflictException(
          '다른 곳에서 먼저 수정했습니다. 최신 정보를 불러온 뒤 다시 저장해 주세요.',
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
        ...(biz
          ? [
              change(
                '사업자등록번호',
                target.bizRegistrationNumber,
                biz.bizRegistrationNumber,
              ),
              change('대표자명', target.bizCeoName, biz.bizCeoName),
              change('개업일자', dateOnly(target.bizOpenDate), biz.bizOpenDate),
            ]
          : []),
        ...(clear
          ? [
              change('사업자등록번호', target.bizRegistrationNumber, null),
              change('대표자명', target.bizCeoName, null),
              change('개업일자', dateOnly(target.bizOpenDate), null),
            ]
          : []),
      ].filter((c): c is History => c !== null);
      if (changes.length)
        await tx.bpChangeHistory.createMany({
          data: changes.map((c) => ({
            bpCodeId,
            ...c,
            changedBy: adminAccountId,
            ...(biz &&
              ['사업자등록번호', '대표자명', '개업일자'].includes(c.field) && {
                note: '사업자 번호 인증',
              }),
            ...(clear &&
              ['사업자등록번호', '대표자명', '개업일자'].includes(c.field) && {
                note: '사업자 번호 인증 해제',
              }),
          })),
        });
    });
  }

  /** 부르기 전에 센다 — 동시에 여러 번 눌러도 한도를 넘지 않게(StoreManagementService.countNtsCall 과 같다). */
  private countNtsCall(adminAccountId: number): void {
    const now = Date.now();
    const recent = (this.ntsCallsAt.get(adminAccountId) ?? []).filter(
      (at) => now - at < NTS_WINDOW_MS,
    );
    if (recent.length >= NTS_CALLS_PER_HOUR)
      throw new HttpException(
        `사업자 인증은 한 시간에 ${NTS_CALLS_PER_HOUR}번까지 할 수 있습니다. 잠시 후 다시 시도해 주세요.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    recent.push(now);
    this.ntsCallsAt.set(adminAccountId, recent);
    for (const [admin, times] of this.ntsCallsAt)
      if (times.every((at) => now - at >= NTS_WINDOW_MS))
        this.ntsCallsAt.delete(admin);
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
