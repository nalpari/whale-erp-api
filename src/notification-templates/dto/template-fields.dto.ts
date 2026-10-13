import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  NotificationTemplateChannel,
  PreferenceCategory,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** 변수 목록 한 줄. 화면의 변수 단추 · 미리보기 · 저장 검사가 이 목록을 쓴다. */
export class TemplateVariableDto {
  /** 변수 이름 — 본문에 #{이름} 으로 쓴다. # · 중괄호 · 공백 없이, 한글 가능 */
  @IsString()
  @MaxLength(50)
  name: string;

  /** 표시 이름 */
  @IsString()
  @MaxLength(100)
  label: string;

  @IsBoolean()
  isRequired: boolean;

  /** 미리보기에 넣는 예시 값 */
  @IsString()
  @MaxLength(500)
  sampleValue: string;

  /** 버튼 링크 — 메일 공통 틀 · 알림톡 버튼이 붙인다. 메일 · 알림톡에만 (NOTIFY-20) */
  @IsOptional()
  @IsBoolean()
  isButtonLink?: boolean;
}

/** 등록 · 수정이 함께 받는 칸. 채널별 필수 칸과 #{변수} 검사는 validateTemplate 이 본다. */
export class TemplateFieldsDto {
  @ApiProperty({
    enum: NotificationTemplateChannel,
    enumName: 'NotificationTemplateChannel',
  })
  @IsEnum(NotificationTemplateChannel)
  channel: NotificationTemplateChannel;

  @IsString()
  @MaxLength(100)
  templateName: string;

  /** 템플릿 코드 — 발송 코드가 이 값으로 부른다. 고칠 수 있다 */
  @IsString()
  @MaxLength(100)
  templateCode: string;

  /** 수신 설정 묶음 — 앱 푸시만 */
  @ApiPropertyOptional({
    enum: PreferenceCategory,
    enumName: 'PreferenceCategory',
    nullable: true,
  })
  @IsOptional()
  @IsEnum(PreferenceCategory)
  preferenceCategory?: PreferenceCategory | null;

  /** 제목 — 알림톡은 비운다 */
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string | null;

  @IsString()
  @MaxLength(5000)
  body: string;

  /** 카카오 템플릿 코드 — 알림톡만 */
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  kakaoTemplateCode?: string | null;

  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => TemplateVariableDto)
  variables: TemplateVariableDto[];
}
