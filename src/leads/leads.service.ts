import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PLATFORM_BP_CODE } from '../code-groups/code-format';
import { PrismaService } from '../prisma/prisma.service';
import { CreateLeadDto, INDUSTRY_OTHER } from './dto/create-lead.dto';

/** 같은 전화번호 · 이메일로 다시 접수할 수 있을 때까지 (Plane #295, 2026-10-12 재영). */
const REPEAT_WINDOW_MS = 10 * 60_000;

/**
 * 도입문의 (Plane #295). 고객지원 문의사항(`inquiries`)과 다른 유형으로 따로 관리한다.
 * 개인정보를 담으므로 상담 완료일로부터 1년 뒤 파기한다(운영 정책 CNT-12).
 */
@Injectable()
export class LeadsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateLeadDto): Promise<void> {
    await this.assertActiveCode('INDUSTRY', dto.industryCode);
    // @IsOptional 은 null 도 통과시키므로 null · undefined 둘 다 「고르지 않음」이다.
    if (dto.planPeriodCode != null)
      await this.assertActiveCode('PLAN_PERIOD', dto.planPeriodCode);

    const now = new Date();
    // 거듭 누른 제출은 거의 동시에 온다. 잠그지 않으면 둘 다 아래 확인을 통과해 둘 다 저장된다.
    // 전화번호 · 이메일 키를 늘 이 순서로 잡는다 — 순서가 같으면 두 요청이 서로를 기다리는 일이 없고,
    // 다른 번호 · 이메일의 접수는 줄을 서지 않는다. 키는 배치 잡 이름(BATCH_JOB)과 같은 advisory lock
    // 공간을 쓰므로 `lead-intake:` 로 시작하게 둔다.
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`lead-intake:phone:${dto.phone}`}))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`lead-intake:email:${dto.email}`}))`;
      const recent = await tx.lead.findFirst({
        where: {
          createdAt: { gt: new Date(now.getTime() - REPEAT_WINDOW_MS) },
          OR: [{ phone: dto.phone }, { email: dto.email }],
        },
        select: { leadId: true },
      });
      // 안내 문구는 Manyfast 「도입문의 등록」 · 운영 정책 CNT-14 (2026-10-13 재영).
      if (recent)
        throw new HttpException(
          '이미 접수된 문의가 있습니다. 담당자가 영업일 기준 1~2일 안에 연락드립니다',
          HttpStatus.TOO_MANY_REQUESTS,
        );

      await tx.lead.create({
        data: {
          contactName: dto.contactName,
          industryCode: dto.industryCode,
          industryDetail:
            dto.industryCode === INDUSTRY_OTHER ? dto.industryDetail : null,
          phone: dto.phone,
          email: dto.email,
          interests: dto.interests,
          planPeriodCode: dto.planPeriodCode ?? null,
          body: dto.body,
          privacyAgreedAt: now,
          marketingAgreedAt: dto.marketingAgreed ? now : null,
        },
      });
    });
  }

  /**
   * 상담 완료일로부터 1년이 지난 도입문의를 지운다. 완료일 당일부터 1년째 되는 날까지 남고 그다음 날
   * 지워진다. 날짜는 한국 날짜로 센다 — DB 세션 타임존(UTC)의 날짜로 세면 한국 자정 직후에는 아직
   * 전날이라 하루 늦게 지운다.
   * 상담 완료일이 비어 있는(상담이 안 끝난) 행은 남는다.
   */
  async purgeExpired(tx: Prisma.TransactionClient): Promise<number> {
    return tx.$executeRaw`
      DELETE FROM "leads"
      WHERE "consulted_date" < (now() AT TIME ZONE 'Asia/Seoul')::date - interval '1 year'
    `;
  }

  /** 업종 · 도입 예정 시기는 플랫폼고정 공통코드다. 사용 중지한 값은 받지 않는다. */
  private async assertActiveCode(
    groupCode: 'INDUSTRY' | 'PLAN_PERIOD',
    itemCode: string,
  ): Promise<void> {
    const found = await this.prisma.codeItem.count({
      where: {
        groupCode,
        itemCode,
        bpCode: PLATFORM_BP_CODE,
        status: 'ACTIVE',
        isDeleted: false,
      },
    });
    if (!found)
      // 화면은 공통코드 그룹 이름을 모르므로 칸 이름으로 알린다. 운영자가 막 사용 중지한
      // 값이 화면 캐시에 남아 있을 때 나는 오류다.
      throw new BadRequestException(
        groupCode === 'INDUSTRY'
          ? '업종을 다시 선택해 주세요'
          : '도입 예정 시기를 다시 선택해 주세요',
      );
  }
}
