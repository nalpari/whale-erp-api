import { Transform } from 'class-transformer';
import { Length, Matches } from 'class-validator';
import { IsDateOnly } from '../../common/is-date-only';
import { trimText } from '../../platform-admins/platform-admin-format';

/**
 * 내 BP 사업자 번호 인증 — 검사만(재인증 포함, S-UOJVUR). 세 값을 모두 받는다 — 재인증도 처음 인증과
 * 같다. BusinessVerificationService(admin-signup, 가입과 같은 서비스를 그대로 쓴다)가 중복 확인 →
 * 국세청 진위확인 순서로 본다. 저장은 하지 않는다(점포 사업자정보와 같은 패턴, 2026-10-22 사용자 결정) —
 * 통과하면 받은 토큰을 「저장」(PATCH /me/bp)에 실어야 실제로 반영된다. 그래서 updatedAt(동시 수정 잠금)은
 * 여기 없다 — 저장할 때만 필요하다.
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
  @IsDateOnly('개업일자는 YYYY-MM-DD 로 입력해 주세요.')
  bizOpenDate: string;
}
