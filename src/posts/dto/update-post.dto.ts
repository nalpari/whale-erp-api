import { IsUpdatedAt } from '../../common/updated-at';
import { PostFieldsDto } from './post-fields.dto';

export class UpdatePostDto extends PostFieldsDto {
  /**
   * 고치기 전에 읽은 `updatedAt` 그대로. 그 뒤 누가 고쳤으면 409 이고, 상세를 다시 읽어 최신 내용을 본다.
   * @example 2026-10-13T01:02:03.456Z
   */
  @IsUpdatedAt()
  updatedAt: string;
}
