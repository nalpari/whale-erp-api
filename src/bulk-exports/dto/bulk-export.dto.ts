import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BulkExportStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { INT4_MAX } from '../../platform-admins/platform-admin-format';

/** `a=1&a=2` · `a=1,2` · 둘을 섞은 `a=1,2&a=3` 을 모두 같은 배열로 받는다(직원 목록 StaffMemberListQueryDto 와 같다). */
const splitComma = ({ value }: { value: unknown }): unknown =>
  (Array.isArray(value) ? value : [value]).flatMap((v: unknown) =>
    typeof v === 'string' ? v.split(',') : [v],
  );

/** splitComma 에 숫자 변환까지. 숫자만 받는다 — 빈 조각 · 공백 · `0x10` 은 NaN 으로 두어 검증이 막는다(400). */
const splitNumbers = ({ value }: { value: unknown }): unknown =>
  (splitComma({ value }) as unknown[]).map((p) =>
    typeof p === 'string' && /^\d+$/.test(p) ? Number(p) : NaN,
  );

export class BulkExportPreviewQueryDto {
  /**
   * 업무 범위 점포(범위 선택기). 반복(`storeIds=1&storeIds=2`)과 쉼표(`storeIds=1,2`)를 모두 받는다. 주지 않으면 관리하는
   * 점포 전부. 관리하지 않는 점포가 섞이면 400
   */
  @ApiPropertyOptional({ type: [Number], example: [3, 5] })
  @IsOptional()
  @Transform(splitNumbers)
  @ArrayMaxSize(1000)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(INT4_MAX, { each: true })
  storeIds?: number[];
}

export class CreateBulkExportDto {
  /** 업무 범위 점포. 비거나 없으면 관리하는 점포 전부. 관리하지 않는 점포가 섞이면 400 */
  @ApiPropertyOptional({ type: [Number], example: [3, 5] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(INT4_MAX, { each: true })
  storeIds?: number[];
}

export class BulkExportListQueryDto {
  /** 페이지, 1부터 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  page?: number;

  /** 페이지당 건수, 기본 20 · 최대 100 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class BulkExportPreviewResponseDto {
  /** 범위 점포 수 */
  storeCount: number;
  /** 담을 직원 수(재직 + 퇴직). 0 이면 요청 버튼을 끈다 */
  staffCount: number;
  /** 재직 */
  employedCount: number;
  /** 퇴직(퇴직일 다음 날부터 3년 안) */
  retiredCount: number;
  /** 같은 범위의 파일을 만드는 중인가 */
  inProgress: boolean;
}

export class BulkExportItemDto {
  bulkExportId: number;
  /** 요청의 업무 범위 점포(오름차순) — 「다시 요청」이 같은 범위로 보낸다 */
  storeIds: number[];
  /** 요청 일시(ISO) */
  requestedAt: string;
  /** 요청한 관리자 이름(없으면 로그인 아이디) */
  requesterName: string;
  /** 담은 직원 수 */
  staffCount: number;
  @ApiProperty({ enum: BulkExportStatus, enumName: 'BulkExportStatus' })
  status: BulkExportStatus;
  /** 완료 일시(ISO) */
  completedAt: string | null;
  /** 받을 수 있는 기한(ISO) — 완료 + 7일 */
  expiresAt: string | null;
  /** 기한이 지났는가 */
  isExpired: boolean;
  /** 실패 사유 */
  failureReason: string | null;
}

export class BulkExportListResponseDto {
  items: BulkExportItemDto[];
  total: number;
}

export class BulkExportDownloadResponseDto {
  /** 5분짜리 내려받기 주소 */
  url: string;
  fileName: string;
  /** 파일을 받을 수 있는 기한(ISO) */
  expiresAt: string;
}
