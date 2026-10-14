import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CodeValueDto } from './dto/code-items.response.dto';

/** 플랫폼 BP 코드. 공통코드 원본 행은 이 BP 로 저장된다(1팀 초기 데이터). */
export const PLATFORM_BP_CODE = 'BP000000';

export type CodesByGroup = Record<string, CodeValueDto[]>;

/**
 * 공통코드(1팀 code_groups · code_items) 조회. 그룹마다 어느 BP 의 행을 쓸지가 다르다 — 플랫폼제공 그룹을
 * BP 에 적용하면 그 순간 BP 별 행이 복사되고, 그 뒤로 BP 는 자기 행(이름을 고친 것 · BP전용 추가)을 본다.
 * 플랫폼고정 그룹과 아직 적용하지 않은 플랫폼제공 그룹은 플랫폼 원본을 본다.
 */
@Injectable()
export class CodesService {
  constructor(private readonly prisma: PrismaService) {}

  /** 그 BP 가 보는 공통코드 전체. 관리자 로그인 정보가 쓴다. */
  forBp(bpCode: string): Promise<CodesByGroup> {
    return this.read(bpCode);
  }

  /**
   * 로그인 전 화면이 BP 코드로 부른다(플랫폼 BP000000). 삭제 · 탈퇴한 BP 는 없는 BP 와 같이 404 다.
   * 그룹을 고르면 그 그룹만.
   */
  async forLiveBp(
    bpCode: string,
    groupCodes?: string[],
  ): Promise<CodesByGroup> {
    const bp = await this.prisma.bpCode.findFirst({
      where: {
        bpCode,
        isDeleted: false,
        accountStatusCode: { not: 'WITHDRAWN' },
      },
      select: { bpCodeId: true },
    });
    if (!bp) throw new NotFoundException('BP 를 찾을 수 없습니다');
    return this.readGroups(bpCode, groupCodes);
  }

  /**
   * 로그인한 사용자가 BP id 로 부르는 그 BP 의 공통코드. 없거나 삭제된 BP 면 null. 플랫폼 BP 도 탈퇴한 BP 도
   * 막지 않는다 — 공개 경로로도 보이는 코드와 이름이고, 탈퇴한 BP 의 기록도 봐야 한다.
   */
  async forBpId(
    bpCodeId: number,
    groupCodes?: string[],
  ): Promise<CodesByGroup | null> {
    const bp = await this.prisma.bpCode.findFirst({
      where: { bpCodeId, isDeleted: false },
      select: { bpCode: true },
    });
    if (!bp) return null;
    return this.readGroups(bp.bpCode, groupCodes);
  }

  /** 그룹을 고르면 없거나 사용하지 않는 그룹도 빈 목록으로 키를 둔다. 화면이 `codes[GROUP]` 을 바로 읽게. */
  private async readGroups(bpCode: string, groupCodes?: string[]) {
    const codes = await this.read(bpCode, groupCodes);
    for (const groupCode of groupCodes ?? []) codes[groupCode] ??= [];
    return codes;
  }

  private async read(
    bpCode: string,
    groupCodes?: string[],
  ): Promise<CodesByGroup> {
    const groups = await this.prisma.codeGroup.findMany({
      where: {
        isDeleted: false,
        status: 'ACTIVE',
        ...(groupCodes && { groupCode: { in: groupCodes } }),
      },
      orderBy: [{ sortOrder: 'asc' }, { groupCode: 'asc' }],
      select: { groupCode: true, manageOwnerCode: true, isBpApplied: true },
    });
    const items = await this.prisma.codeItem.findMany({
      where: {
        isDeleted: false,
        status: 'ACTIVE',
        groupCode: { in: groups.map((g) => g.groupCode) },
        bpCode: {
          in:
            bpCode === PLATFORM_BP_CODE
              ? [PLATFORM_BP_CODE]
              : [PLATFORM_BP_CODE, bpCode],
        },
      },
      orderBy: [{ sortOrder: 'asc' }, { itemCode: 'asc' }],
      select: { groupCode: true, itemCode: true, bpCode: true, label: true },
    });

    const codes: CodesByGroup = {};
    for (const group of groups) {
      const source =
        group.manageOwnerCode === 'PLATFORM_PROVIDED' && group.isBpApplied
          ? bpCode
          : PLATFORM_BP_CODE;
      codes[group.groupCode] = items
        .filter((i) => i.groupCode === group.groupCode && i.bpCode === source)
        .map((i, index) => ({
          value: i.itemCode,
          label: i.label,
          order: index + 1,
        }));
    }
    return codes;
  }
}
