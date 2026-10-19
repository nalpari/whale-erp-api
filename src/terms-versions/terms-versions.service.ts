import { Injectable } from '@nestjs/common';
import { CodesService } from '../codes/codes.service';
import { PrismaService } from '../prisma/prisma.service';
import { kstToday } from '../staff-members/kst-date';
import {
  TermsVersionDetailResponseDto,
  TermsVersionListResponseDto,
  TermsVersionResponseDto,
} from './dto/terms-version.response.dto';

const SUMMARY = {
  termsTypeCode: true,
  title: true,
  version: true,
  effectiveDate: true,
} as const;

/**
 * 로그인 전 약관 화면이 부르는 지금 시행 중인 약관. 고르는 규칙은 동의를 남기는 두 곳(회원가입 AdminSignupService,
 * 첫 로그인 AdminPasswordChangeService)과 같다 — 사용 중 · 미삭제 · 시행일이 KST 오늘 이하인 행 가운데 시행일이
 * 늦은 것. 그래야 화면에 보인 버전에 동의가 남는다.
 * 탭 이름 · 순서는 플랫폼 BP 의 공통코드 `TERMS_TYPE` 이고, 그 코드를 쓰지 않게 하면 여기서는 약관이 빠진다. 동의를
 * 남기는 두 곳은 공통코드를 보지 않아 그 약관에 계속 동의를 받는다 — 필수 약관의 코드는 끄지 않는다.
 */
@Injectable()
export class TermsVersionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly codes: CodesService,
  ) {}

  async findAll(): Promise<TermsVersionListResponseDto> {
    const types = await this.types();
    const rows = await this.prisma.termsVersion.findMany({
      where: this.current({ in: types.map((t) => t.value) }),
      orderBy: [{ effectiveDate: 'desc' }, { termsVersionId: 'desc' }],
      select: SUMMARY,
    });
    const items = types.flatMap((type) => {
      const row = rows.find((r) => r.termsTypeCode === type.value);
      return row ? [summary(row, type.label)] : [];
    });
    return { items, total: items.length };
  }

  async findOne(
    termsTypeCode: string,
  ): Promise<TermsVersionDetailResponseDto | null> {
    const type = (await this.types()).find((t) => t.value === termsTypeCode);
    if (!type) return null;
    const row = await this.prisma.termsVersion.findFirst({
      where: this.current(termsTypeCode),
      orderBy: [{ effectiveDate: 'desc' }, { termsVersionId: 'desc' }],
      select: { ...SUMMARY, content: true },
    });
    return row && { ...summary(row, type.label), content: row.content };
  }

  private async types() {
    return (await this.codes.forPlatform(['TERMS_TYPE'])).TERMS_TYPE;
  }

  private current(termsTypeCode: string | { in: string[] }) {
    return {
      termsTypeCode,
      isActive: true,
      isDeleted: false,
      effectiveDate: { lte: kstToday() },
    };
  }
}

function summary(
  row: {
    termsTypeCode: string;
    title: string;
    version: string;
    effectiveDate: Date;
  },
  label: string,
): TermsVersionResponseDto {
  return {
    termsTypeCode: row.termsTypeCode,
    label,
    title: row.title,
    version: row.version,
    effectiveDate: row.effectiveDate.toISOString().slice(0, 10),
  };
}
