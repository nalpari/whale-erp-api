import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * 본사 제공 동의 본문 (ATT-30). 화면이 보여 준 동의 문구의 버전을 반드시 싣는다 — 위치정보 동의(termsVersion)와 같이, 그사이
 * 지금 버전이 바뀌었으면 409 로 거절해 보인 문구와 남는 동의 버전이 어긋나지 않게 한다(운영 정책 ATT-30 v252, 2026-10-29 재영).
 * 빼면 400 이다 — 버전을 싣지 않는 예전 앱(열어 둔 탭 · PWA)이 예전 문구로 받은 동의를 지금 버전으로 남기지 못하게. 문구는 직원
 * 앱에 있어 보인 문구가 없는 경우가 없으므로 null 은 받지 않는다.
 */
export class AgreeHqSharingConsentDto {
  /** 화면이 보여 준 본사 제공 동의 문구 버전 — 예: v1.0 */
  @IsString({
    message: '화면에 보인 동의 문구 버전(consentVersion)을 보내 주세요.',
  })
  @IsNotEmpty({
    message: '화면에 보인 동의 문구 버전(consentVersion)을 보내 주세요.',
  })
  @MaxLength(64, {
    message: '동의 문구 버전(consentVersion)은 64자 이하입니다.',
  }) // 버전 칸은 길이 제한이 없다 — 「v1.0」 꼴보다 넉넉히, 위치정보 동의와 같은 상한
  consentVersion: string;
}
