import { IsBoolean, IsISO8601, Matches } from 'class-validator';
import { TemplateFieldsDto } from './template-fields.dto';

const UPDATED_AT_MESSAGE =
  'updatedAt 은 상세 응답의 값 그대로(시간대 포함) 보내야 합니다.';

/** 등록 */
export class CreateTemplateDto extends TemplateFieldsDto {
  @IsBoolean()
  isActive: boolean;
}

/** 읽은 뒤 누가 고쳤는지 가르는 값. 상세 응답의 updatedAt 그대로 */
export class TemplateVersionDto {
  /** @example 2026-10-13T01:02:03.456Z */
  @IsISO8601({ strict: true })
  @Matches(/T.*(Z|[+-]\d{2}:\d{2})$/, { message: UPDATED_AT_MESSAGE })
  updatedAt: string;
}

/** 수정 — 모든 칸을 고친다(NOTIFY-10). 사용 여부는 따로 바꾼다 */
export class UpdateTemplateDto extends TemplateFieldsDto {
  /** @example 2026-10-13T01:02:03.456Z */
  @IsISO8601({ strict: true })
  @Matches(/T.*(Z|[+-]\d{2}:\d{2})$/, { message: UPDATED_AT_MESSAGE })
  updatedAt: string;
}

/** 사용 / 사용 안 함 */
export class SetTemplateActiveDto extends TemplateVersionDto {
  @IsBoolean()
  isActive: boolean;
}
