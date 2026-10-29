import { IsString, Matches, MaxLength } from 'class-validator';
import { NO_NUL } from '../../common/no-nul';
import { IsUpdatedAt } from '../../common/updated-at';

/** 문의 답변 저장. 답변을 고칠 때도 이것으로 새 답변 행을 더한다(운영 정책 CNT-17). */
export class CreateInquiryReplyDto {
  /** 문의자에게 보이는 답변. 평문이고 20,000자까지. 첨부파일은 받지 않는다(CNT-18). */
  @IsString()
  @MaxLength(20_000)
  @Matches(/\S/, { message: '답변을 입력해 주세요.' })
  @Matches(NO_NUL, { message: '답변에 쓸 수 없는 문자가 있습니다.' })
  body: string;

  /**
   * 답변하기 전에 읽은 문의의 `updatedAt` 그대로. 그사이 다른 운영자가 처리중 전환 · 답변 · 메모를 저장했으면 409 이고,
   * 다시 읽어 최신 내용을 본다.
   * @example 2026-10-14T01:02:03.456Z
   */
  @IsUpdatedAt()
  updatedAt: string;
}
