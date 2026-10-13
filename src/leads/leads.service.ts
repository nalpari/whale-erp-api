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
    if (dto.planPeriodCode)
      await this.assertActiveCode('PLAN_PERIOD', dto.planPeriodCode);

    // ponytail: 확인과 저장 사이가 잠기지 않아 동시에 온 같은 번호 두 건은 둘 다 들어간다.
    // 막으려는 것은 거듭 누른 제출이고 자동 등록은 IP 한도가 거르므로 그대로 둔다.
    const now = new Date();
    const recent = await this.prisma.lead.findFirst({
      where: {
        createdAt: { gt: new Date(now.getTime() - REPEAT_WINDOW_MS) },
        OR: [{ phone: dto.phone }, { email: dto.email }],
      },
      select: { leadId: true },
    });
    // 안내 문구는 미정이다(Manyfast 질문). 정해지면 이 문구만 바꾼다.
    if (recent)
      throw new HttpException(
        '같은 전화번호나 이메일로 방금 접수된 문의가 있습니다. 10분 뒤에 다시 보내 주세요.',
        HttpStatus.TOO_MANY_REQUESTS,
      );

    await this.prisma.lead.create({
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
  }

  /**
   * 상담 완료일로부터 1년이 지난 도입문의를 지운다. 완료일 당일부터 1년째 되는 날까지 남고 그다음 날
   * 지워진다. 날짜는 한국 날짜로 센다 — 서버 타임존 자정이면 9시간 일찍 지운다.
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
    groupCode: string,
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
      throw new BadRequestException(`${groupCode} 에 없는 코드: ${itemCode}`);
  }
}
