import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, Matches, ValidateIf } from 'class-validator';

const toCode = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

/**
 * 로그인한 직원이 다른 근무지의 초대를 찾는 값(WHALEERP-603). 휴대전화번호는 받지 않는다 — 계정의 번호로 찾는다. 앱 안에서
 * 초대 코드를 넣었으면 코드, 로그인한 채 초대 링크로 들어왔으면 토큰 — 둘 가운데 하나만 보낸다(서비스가 본다).
 */
export class MyInvitationLookupDto {
  /** 초대 링크의 토큰(base64url 43자) */
  @ValidateIf((_, v) => v !== undefined)
  @Matches(/^[A-Za-z0-9_-]{43}$/, { message: '초대 링크가 올바르지 않습니다' })
  token?: string;

  /** 초대 코드 — 대문자 · 숫자 8자리, 0 · O · 1 · I 는 없다. 소문자로 넣어도 대문자로 맞춰 본다 */
  @ValidateIf((_, v) => v !== undefined)
  @Transform(toCode)
  @Matches(/^[A-HJ-NP-Z2-9]{8}$/, {
    message: '초대 코드는 영문 대문자 · 숫자 8자리입니다',
  })
  code?: string;
}

/** 근무지 더하기 — 초대를 찾는 값과 본사 제공 동의 */
export class AcceptMyInvitationDto extends MyInvitationLookupDto {
  /**
   * 본사 제공 동의(운영 정책 ATT-30, 선택). 확인의 asksHqSharingConsent 가 true 일 때만 쓴다 — 직영 점포이거나 계정이
   * 받아 주는 문구 버전에 이미 동의했으면 보내도 바꾸지 않는다. 더는 받아 주지 않는 버전에 동의했으면 true 로 지금 버전에
   * 다시 동의한다. 동의는 계정에 하나다(api #78)
   */
  @IsOptional()
  @IsBoolean()
  hqSharingConsented?: boolean;
}

/** 더한 근무지 — 앱이 그 소속의 날인 대기 근로계약서로 간다 */
export class AcceptMyInvitationResponseDto {
  /** 이 계정에 이어진 직원 레코드 */
  staffMemberId: number;

  /** 근무지(점포) 이름 */
  storeName: string;
}
