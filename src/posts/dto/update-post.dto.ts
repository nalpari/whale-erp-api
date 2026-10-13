import { IsISO8601, Matches } from 'class-validator';
import { PostFieldsDto } from './post-fields.dto';

export class UpdatePostDto extends PostFieldsDto {
  /**
   * 고치기 전에 읽은 `updatedAt` 그대로. 그 뒤 누가 고쳤으면 409 이고, 상세를 다시 읽어 최신 내용을 본다.
   * @example 2026-10-13T01:02:03.456Z
   */
  @IsISO8601({ strict: true })
  // 오프셋이 없으면 서버 시간대로 읽혀, 서버가 UTC 가 아니면 409 가 된다(환경마다 다르다). 400 으로 바로 드러나게 한다.
  @Matches(/T.*(Z|[+-]\d{2}:\d{2})$/, {
    message: 'updatedAt 은 상세 응답의 값 그대로(시간대 포함) 보내야 합니다',
  })
  updatedAt: string;
}
