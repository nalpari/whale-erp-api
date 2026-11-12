import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TargetBpContext } from '../auth/menu-permission.guard';
import { PLATFORM_BP_CODE } from '../codes/codes.service';
import { PrismaService } from '../prisma/prisma.service';
import type {
  BulkCreateResponseDto,
  BulkPreviewResponseDto,
} from './dto/facility-bulk.response.dto';
import {
  BULK_HAS_ERRORS,
  BULK_PREVIEW_COLUMNS,
  type BulkCode,
  type BulkLookups,
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

/**
 * 시설물·장비 엑셀 일괄 등록(정책서 PL-7) — 양식 · 미리보기 · 오류 파일 · 등록. 파일은 남기지 않고 단계마다 다시 받는다.
 * 점포 범위 · 다루는 BP 는 화면 경로(FacilitiesService)와 같고(facility-caller), 줄 검사는 facility-bulk.ts 가 한다.
 */
@Injectable()
export class FacilityBulkService {
  constructor(private readonly prisma: PrismaService) {}

  /** 양식 .xlsx — 둘째 시트에 범위 안 열린 점포, 드롭다운에 그 BP 의 사용 중인 공통코드 */
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
    const { rows } = await this.check(callerId, bp, file);
    const validCount = rows.filter((r) => r.errors.length === 0).length;
    return {
      fileName: file?.originalname ?? '',
      totalCount: rows.length,
      validCount,
      errorCount: rows.length - validCount,
      columns: BULK_PREVIEW_COLUMNS.map((c) => ({ ...c })),
      rows: rows.map((r) => ({
        rowNumber: r.rowNumber,
        isValid: r.errors.length === 0,
        values: r.values,
        errors: r.errors,
      })),
    };
  }

  /** 오류 파일 — 올린 파일 끝에 「오류 사유」 열 */
  async errorFile(
    callerId: number,
    bp: TargetBpContext,
    file: BulkUpload | undefined,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const { rows, upload, parsed } = await this.check(callerId, bp, file);
    const errors = new Map(rows.map((r) => [r.rowNumber, r.errors]));
    return {
      buffer: await buildBulkErrorFile(parsed, errors),
      fileName: bulkErrorFileName(upload.originalname),
    };
  }

  /**
   * 등록 — 같은 검사를 다시 하고, 오류가 한 줄이라도 있으면 하나도 넣지 않는다(PL-7 제안). 넣기 전에 점포 행을 id 순서로
   * 공유 잠금해(폐점 · 삭제와 줄을 선다, 화면 등록과 같다) 그 사이 폐점 · 삭제됐으면 400 — 화면은 미리보기를 다시 받는다.
   */
  async register(
    callerId: number,
    bp: TargetBpContext,
    file: BulkUpload | undefined,
  ): Promise<BulkCreateResponseDto> {
    const { rows, caller } = await this.check(callerId, bp, file);
    if (rows.some((r) => r.errors.length || !r.data))
      throw new BadRequestException(BULK_HAS_ERRORS);
    const data = rows.map((r) => r.data!);
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
        throw new BadRequestException(BULK_HAS_ERRORS);
      const created = await tx.facility.createMany({
        data: data.map((d) => ({ ...d, createdBy: caller.adminAccountId })),
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

  /** 줄 검사 · 양식에 쓰는 점포 · 공통코드 */
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
      this.prisma.codeGroup.findMany({
        where: { groupCode: { in: [...FACILITY_GROUPS] } },
        select: { groupCode: true, groupName: true },
      }),
    ]);
    const of = (group: string): BulkCode[] =>
      codes
        .filter((c) => c.groupCode === group)
        .map((c) => ({ code: c.itemCode, label: c.label }));
    const nameOf = new Map(groups.map((g) => [g.groupCode, g.groupName]));
    return {
      stores: new Map(
        stores.map((s) => [
          s.storeCode,
          {
            storeId: s.storeId,
            name: s.name,
            isClosed: s.storeStatusCode === 'CLOSED',
          },
        ]),
      ),
      statuses: of(FACILITY_STATUS_GROUP),
      groups: FACILITY_GROUPS.map((code) => ({
        code,
        label: nameOf.get(code) ?? code,
      })),
      categories: Object.fromEntries(
        FACILITY_GROUPS.map((g) => [g, of(g)]),
      ) as Record<FacilityGroup, BulkCode[]>,
      cycles: of(INSPECTION_CYCLE_GROUP),
    };
  }
}
