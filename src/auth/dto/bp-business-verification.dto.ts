import { Transform } from 'class-transformer';
import { IsISO8601, Length, Matches } from 'class-validator';
import { IsUpdatedAt } from '../../common/updated-at';
import { trimText } from '../../platform-admins/platform-admin-format';

/**
 * 내 BP 사업자 번호 인증(재인증 포함, S-UOJVUR). 세 값을 모두 다시 받는다 — 재인증도 처음 인증과 같다.
 * BusinessVerificationService(admin-signup, 가입과 같은 서비스를 그대로 쓴다)가 중복 확인 → 국세청
 * 진위확인 순서로 본다.
 */
export class BpBusinessVerificationDto {
  /** 사업자등록번호. 하이픈 없이 숫자 10자리. @example 1058763602 */
  @Matches(/^[0-9]{10}$/, { message: '사업자등록번호는 숫자 10자리입니다' })
  bizRegistrationNumber: string;

  /** 대표자명. @example 김하늘 */
  @Transform(trimText)
  @Length(1, 50, { message: '대표자명을 입력해 주세요.' })
  bizCeoName: string;

  /** 개업일자(YYYY-MM-DD). @example 2020-03-02 */
  @IsISO8601({ strict: true }, { message: '개업일자 형식이 아닙니다' })
  bizOpenDate: string;

  /** 내 사업자정보 조회 응답의 updatedAt 그대로. 그사이 다른 저장이 있었으면 409. */
  @IsUpdatedAt()
  updatedAt: string;
}
