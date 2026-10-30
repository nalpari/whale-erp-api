import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { CONSENT_VERSION_MAX } from '../../staff-signup/hq-sharing-consent';

/**
 * 본사 제공 동의 본문 (ATT-30). 화면이 보여 준 동의 문구의 버전을 반드시 싣는다 — 위치정보 동의(termsVersion)와 같이, 그사이
 * 지금 버전이 바뀌었으면 409 로 거절해 보인 문구와 남는 동의 버전이 어긋나지 않게 한다(운영 정책 ATT-30 v252, 2026-10-29 재영).
 * 빼면 400 이다 — 버전을 싣지 않는 예전 앱(열어 둔 탭 · PWA)이 예전 문구로 받은 동의를 지금 버전으로 남기지 못하게. 문구는 직원
 * 앱에 있어 보인 문구가 없는 경우가 없으므로 null 은 받지 않는다.
 */
export class AgreeHqSharingConsentDto {
  /** 화면이 보여 준 본사 제공 동의 문구 버전 — 예: v1.0 */
  // Swagger 플러그인은 IsNotEmpty 를 minLength 로 옮기지 않는다 — 가입 · 수락의 버전 칸과 같게 직접 적는다
  @ApiProperty({ minLength: 1, maxLength: CONSENT_VERSION_MAX })
  @IsString({
    message: '화면에 보인 동의 문구 버전(consentVersion)을 보내 주세요.',
  })
  @IsNotEmpty({
    message: '화면에 보인 동의 문구 버전(consentVersion)을 보내 주세요.',
  })
  @MaxLength(CONSENT_VERSION_MAX, {
    message: '동의 문구 버전(consentVersion)은 64자 이하입니다.',
  })
  consentVersion: string;
}
