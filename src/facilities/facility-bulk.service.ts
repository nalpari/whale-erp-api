import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TargetBpContext } from '../auth/menu-permission.guard';
import { PLATFORM_BP_CODE } from '../codes/codes.service';
import type {
  BulkCreateResponseDto,
  BulkPreviewResponseDto,
} from '../common/bulk-upload.response.dto';
import { PrismaService } from '../prisma/prisma.service';
import {
  BULK_HAS_ERRORS,
  BULK_NO_ERRORS,
  BULK_PREVIEW_COLUMNS,
  BULK_STORE_CHANGED,
  type BulkCode,
  type BulkLookups,
  type BulkStore,
  bulkErrorFileName,
  buildBulkErrorFile,
  buildBulkTemplate,
  checkBulkRow,
  readBulkFile,
} from './facility-bulk';
import {
  type FacilityCaller,
  loadFacilityCaller,
  storeScope,
} from './facility-caller';
import {
  FACILITY_GROUPS,
  FACILITY_STATUS_GROUP,
  type FacilityGroup,
  INSPECTION_CYCLE_GROUP,
} from './facility-format';

/** 올린 파일 — multer 메모리 저장 */
export type BulkUpload = { buffer: Buffer; originalname: string };

const NO_FILE = '올릴 파일을 선택해 주세요.';
export const BULK_CODES_MISSING =
  '시설물 공통코드(운영상태 · 분류)가 설정되지 않아 일괄 등록을 할 수 없습니다. 플랫폼 관리자에게 문의해 주세요.';

/**
 * 시설물·장비 엑셀 일괄 등록(정책서 PL-7) — 양식 · 미리보기 · 오류 파일 · 등록. 파일은 남기지 않고 단계마다 다시 받는다.
 * 점포 범위 · 다루는 BP 는 화면 경로(FacilitiesService)와 같고(facility-caller), 줄 검사는 facility-bulk.ts 가 한다.
 */
@Injectable()
export class FacilityBulkService {
  private readonly logger = new Logger(FacilityBulkService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** 양식 .xlsx — 둘째 시트에 범위 안 열린 점포, 드롭다운에 운영상태(플랫폼 원본) · 그 BP 의 사용 중인 분류 · 점검 주기 */
  async template(callerId: number, bp: TargetBpContext): Promise<Buffer> {
    const caller = await loadFacilityCaller(this.prisma, callerId, bp);
    return buildBulkTemplate(await this.lookups(caller));
  }

  /** 미리보기 — 줄마다 결과 · 보일 글자 · 사유. 파일 자체가 틀리면 400 */
  async preview(
    callerId: number,
    bp: TargetBpContext,
    file: BulkUpload | undefined,
  ): Promise<BulkPreviewResponseDto> {
    const { rows, upload } = await this.check(callerId, bp, file);
    const validCount = rows.filter((r) => r.isValid).length;
    return {
      fileName: upload.originalname,
      totalCount: rows.length,
      validCount,
      errorCount: rows.length - validCount,
      columns: BULK_PREVIEW_COLUMNS.map((c) => ({ ...c })),
      rows: rows.map((r) => ({
        rowNumber: r.rowNumber,
        isValid: r.isValid,
        values: r.values,
        errors: r.errors,
      })),
    };
  }

  /** 오류 파일 — 올린 파일 끝에 「오류 사유」 열. 오류 줄이 하나도 없으면 400(화면이 잘못 부른 것) */
  async errorFile(
    callerId: number,
    bp: TargetBpContext,
    file: BulkUpload | undefined,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const { rows, upload, parsed } = await this.check(callerId, bp, file);
    if (rows.every((r) => r.isValid))
      throw new BadRequestException(BULK_NO_ERRORS);
    const errors = new Map(rows.map((r) => [r.rowNumber, r.errors]));
    return {
      buffer: await buildBulkErrorFile(parsed, errors),
      fileName: bulkErrorFileName(upload.originalname),
    };
  }

  /**
   * 등록 — 같은 검사를 다시 하고, 오류가 한 줄이라도 있으면 하나도 넣지 않는다(PL-7 제안). 미리보기 뒤 등록 요청 전에 점포가
   * 폐점 · 삭제되거나 공통코드가 미사용이 됐으면 그 검사에서 줄 오류로 400 이다. 넣기 전에는 점포 행을 id 순서로 공유
   * 잠금해(폐점 · 삭제와 줄을 선다, 화면 등록과 같다) 이 요청이 검사한 뒤 폐점 · 삭제됐으면 400(점포 변경 문구). 공통코드와
   * 관리 점포 매핑은 잠그지 않는다 — 화면 등록처럼 한 요청 길이의 틈은 둔다.
   */
  async register(
    callerId: number,
    bp: TargetBpContext,
    file: BulkUpload | undefined,
  ): Promise<BulkCreateResponseDto> {
    const { rows, caller } = await this.check(callerId, bp, file);
    const data = rows.flatMap((r) => (r.isValid ? [r.data] : []));
    if (data.length !== rows.length)
      throw new BadRequestException(BULK_HAS_ERRORS);
    const storeIds = [...new Set(data.map((d) => d.storeId))].sort(
      (a, b) => a - b,
    );
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        { store_id: number; store_status_code: string; is_deleted: boolean }[]
      >`SELECT "store_id", "store_status_code", "is_deleted" FROM "stores"
         WHERE "store_id" IN (${Prisma.join(storeIds)})
         ORDER BY "store_id" FOR SHARE`;
      const open = new Set(
        locked
          .filter((s) => !s.is_deleted && s.store_status_code !== 'CLOSED')
          .map((s) => s.store_id),
      );
      if (storeIds.some((id) => !open.has(id)))
        throw new BadRequestException(BULK_STORE_CHANGED);
      const created = await tx.facility.createMany({
        data: data.map(
          (d) =>
            ({
              ...d,
              createdBy: caller.adminAccountId,
            }) satisfies Prisma.FacilityCreateManyInput,
        ),
      });
      return { createdCount: created.count };
    });
  }

  /** 파일을 읽고(양식 · 줄 수 · 빈 파일은 400) 줄마다 검사한다 */
  private async check(
    callerId: number,
    bp: TargetBpContext,
    file: BulkUpload | undefined,
  ) {
    const caller = await loadFacilityCaller(this.prisma, callerId, bp);
    if (!file) throw new BadRequestException(NO_FILE);
    const parsed = await readBulkFile(file.buffer);
    const lookups = await this.lookups(caller);
    const rows = parsed.rows.map((r) => ({
      rowNumber: r.rowNumber,
      ...checkBulkRow(r, lookups),
    }));
    return { rows, caller, upload: file, parsed };
  }

  /**
   * 줄 검사 · 양식에 쓰는 점포 · 공통코드. 운영상태가 하나도 없거나 두 그룹 모두 분류가 없으면(그 BP 에 BP 적용 전 · 그룹
   * 미사용 등) 사용자가 고칠 수 없는 설정 누락이라 경고 로그를 남기고 400 — 모든 줄이 「분류: …」 오류로 보이지 않게 한다.
   */
  private async lookups(caller: FacilityCaller): Promise<BulkLookups> {
    const [stores, codes, groups] = await Promise.all([
      this.prisma.store.findMany({
        where: storeScope(caller),
        select: {
          storeId: true,
          storeCode: true,
          name: true,
          storeStatusCode: true,
        },
      }),
      // 운영상태는 플랫폼고정이라 플랫폼 원본, 분류 · 점검 주기는 플랫폼제공이라 그 BP 의 행(화면 등록과 같다)
      this.prisma.codeItem.findMany({
        where: {
          OR: [
            { groupCode: FACILITY_STATUS_GROUP, bpCode: PLATFORM_BP_CODE },
            {
              groupCode: { in: [...FACILITY_GROUPS, INSPECTION_CYCLE_GROUP] },
              bpCode: caller.targetBpCode,
            },
          ],
          status: 'ACTIVE',
          isDeleted: false,
          codeGroup: { status: 'ACTIVE', isDeleted: false },
        },
        select: { groupCode: true, itemCode: true, label: true },
        orderBy: [{ sortOrder: 'asc' }, { itemCode: 'asc' }],
      }),
      // 그룹 이름 — 상세 코드와 같은 조건(사용 중 · 지우지 않음). 빠진 그룹은 고를 수 없다
      this.prisma.codeGroup.findMany({
        where: {
          groupCode: { in: [...FACILITY_GROUPS] },
          status: 'ACTIVE',
          isDeleted: false,
        },
        select: { groupCode: true, groupName: true },
      }),
    ]);
    const of = (group: string): BulkCode[] =>
      codes
        .filter((c) => c.groupCode === group)
        .map((c) => ({ code: c.itemCode, label: c.label }));
    const nameOf = new Map(groups.map((g) => [g.groupCode, g.groupName]));
    const usableGroups = FACILITY_GROUPS.filter((g) => nameOf.has(g));
    const categories = Object.fromEntries(
      FACILITY_GROUPS.map((g) => [g, usableGroups.includes(g) ? of(g) : []]),
    ) as Record<FacilityGroup, BulkCode[]>;
    const statuses = of(FACILITY_STATUS_GROUP);
    if (
      statuses.length === 0 ||
      FACILITY_GROUPS.every((g) => categories[g].length === 0)
    ) {
      this.logger.warn(
        `시설물 일괄 등록 공통코드 누락 bp=${caller.targetBpCode} 운영상태=${statuses.length} ` +
          FACILITY_GROUPS.map((g) => `${g}=${categories[g].length}`).join(' '),
      );
      throw new BadRequestException(BULK_CODES_MISSING);
    }
    return {
      stores: new Map<string, BulkStore>(
        stores.map((s) => [
          s.storeCode,
          {
            storeId: s.storeId,
            storeCode: s.storeCode,
            name: s.name,
            isClosed: s.storeStatusCode === 'CLOSED',
          },
        ]),
      ),
      statuses,
      groups: usableGroups.map((code) => ({
        code,
        label: nameOf.get(code) ?? code,
      })),
      categories,
      cycles: of(INSPECTION_CYCLE_GROUP),
    };
  }
}
