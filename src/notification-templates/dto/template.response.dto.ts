import { ApiProperty } from '@nestjs/swagger';
import {
  NotificationTemplateChannel,
  PreferenceCategory,
} from '@prisma/client';
import { TemplateVariableDto } from './template-fields.dto';

export class TemplateListItemDto {
  id: number;
  templateCode: string;
  @ApiProperty({
    enum: NotificationTemplateChannel,
    enumName: 'NotificationTemplateChannel',
  })
  channel: NotificationTemplateChannel;
  templateName: string;
  @ApiProperty({
    enum: PreferenceCategory,
    enumName: 'PreferenceCategory',
    nullable: true,
  })
  preferenceCategory: PreferenceCategory | null;
  title: string | null;
  /** 본문 앞 60자 — 알림톡 목록의 본문 요약 */
  bodySummary: string;
  kakaoTemplateCode: string | null;
  isActive: boolean;
  /** 기본 문구가 있는지(마이그레이션으로 넣은 기본 템플릿 46건) — 되돌리기를 보일지 */
  hasDefault: boolean;
  /** 마지막으로 고친 관리자 이름. 아무도 고치지 않았으면 null — 화면은 「기본 문구」 */
  updatedByName: string | null;
  updatedAt: Date;
}

export class TemplateListResponseDto {
  items: TemplateListItemDto[];
  total: number;
}

export class TemplateHistoryDto {
  changedAt: Date;
  changedByName: string | null;
  /** 이 변경에서 바뀐 것 — 예: 「제목 · 본문」 */
  summary: string;
}

export class TemplateDetailDto extends TemplateListItemDto {
  body: string;
  variables: TemplateVariableDto[];
  /** 최근 것부터 */
  histories: TemplateHistoryDto[];
}
