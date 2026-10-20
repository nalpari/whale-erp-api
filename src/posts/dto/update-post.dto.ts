import { Transform } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { IsUpdatedAt } from '../../common/updated-at';
import { PostFieldsDto, toList } from './post-fields.dto';

/** multipart 로 온 숫자 문자열만 정수로 바꾼다. 나머지는 그대로 두어 @IsInt 가 400 을 낸다. */
const toIds = (params: { value: unknown }): unknown =>
  params.value === undefined
    ? undefined
    : (toList(params) as unknown[]).map((v) =>
        typeof v === 'string' && /^\d{1,10}$/.test(v) ? Number(v) : v,
      );

export class UpdatePostDto extends PostFieldsDto {
  /**
   * 고치기 전에 읽은 `updatedAt` 그대로. 그 뒤 누가 고쳤으면 409 이고, 상세를 다시 읽어 최신 내용을 본다.
   * @example 2026-10-13T01:02:03.456Z
   */
  @IsUpdatedAt()
  updatedAt: string;

  /**
   * 뺄 첨부파일 ID. 공지사항만. 보내지 않으면 지금 첨부를 모두 남긴다 — 더할 파일은 같은 요청의 `files` 칸이다.
   * 그 공지의 지우지 않은 첨부가 아니면 400.
   */
  @Transform(toIds)
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(2_147_483_647, { each: true })
  removeAttachmentIds?: number[];
}
