import { IsString, Matches, MaxLength } from 'class-validator';
import { NO_NUL } from '../../common/no-nul';
import { IsUpdatedAt } from '../../common/updated-at';

/** 도입문의 답변 저장. 고칠 때도 이것으로 덮어쓴다(도입문의는 답변 한 칸이다). */
export class SaveLeadReplyDto {
  /** 문의자에게 회신할 답변. 평문이고 20,000자까지. */
  @IsString()
  @MaxLength(20_000)
  @Matches(/\S/, { message: '답변을 입력해 주세요.' })
  @Matches(NO_NUL, { message: '답변에 쓸 수 없는 문자가 있습니다.' })
  reply: string;

  /**
   * 답변하기 전에 읽은 도입문의의 `updatedAt` 그대로. 그사이 다른 운영자가 저장했으면 409 다.
   * @example 2026-10-14T01:02:03.456Z
   */
  @IsUpdatedAt()
  updatedAt: string;
}
