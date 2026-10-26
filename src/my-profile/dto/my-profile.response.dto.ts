import { ApiProperty } from '@nestjs/swagger';
import { AccountStatus } from '@prisma/client';
import {
  LOCATION_CONSENT_STATE_LABELS,
  type LocationConsentState,
} from '../location-consent-state';

/**
 * 본사 제공 동의 (ATT-30). 계정에 하나이고 소속 가맹 점포 모두에 같이 적용된다(2026-10-20). 가맹 점포 소속이 없으면
 * 화면에 보이지 않는다 — 소속은 `GET /me/memberships` 의 `store.storeTypeCode` 로 안다
 */
export class MyHqSharingConsentDto {
  isConsented: boolean;
  /** 동의한 문구의 버전 */
  consentVersion: string | null;
  agreedAt: Date | null;
  /** 철회 일시. 철회하지 않았으면 null */
  withdrawnAt: Date | null;
}

/** 위치정보 동의 (ATT-23 · ATT-26) */
export class MyLocationConsentDto {
  @ApiProperty({
    enum: Object.keys(LOCATION_CONSENT_STATE_LABELS),
    enumName: 'LocationConsentState',
  })
  state: LocationConsentState;
  /** 동의한 약관 버전. 미동의면 null */
  consentVersion: string | null;
  agreedAt: Date | null;
  /** 일시 중지 시각. 일시 중지가 아니면 null */
  pausedAt: Date | null;
  withdrawnAt: Date | null;
  /**
   * 동의한 약관 버전이 지금 시행 중인 것과 달라 다시 동의해야 하는지(ATT-23). 동의 · 일시 중지일 때만 true 일 수 있다 —
   * 앱은 다음 출퇴근 등록 전에 동의 시트를 다시 띄우고 `POST /me/location-consent` 로 새 버전에 동의한다.
   */
  needsReconsent: boolean;
}

export class MyProfileResponseDto {
  accountId: number;
  email: string;
  /** 이름 — 고칠 수 없다 */
  realName: string;
  /** 생년월일(YYYY-MM-DD) — 직원 앱에서는 고칠 수 없다(생년월일은 관리자 정정만, WHALEERP-602) */
  birthDate: string;
  /** 휴대전화번호 — 1차는 읽기 전용 */
  phone: string;
  zipCode: string | null;
  address: string | null;
  addressDetail: string | null;
  @ApiProperty({ enum: AccountStatus, enumName: 'AccountStatus' })
  status: AccountStatus;
  hqSharingConsent: MyHqSharingConsentDto;
  locationConsent: MyLocationConsentDto;
  /**
   * 비밀번호를 마지막으로 정한 시각 — 바꾼 적이 없으면 가입 시각. 오래되면 화면이 변경을 권한다(WHALEERP-194). 몇 달을
   * 「오래」로 볼지는 화면이 정한다
   */
  passwordChangedAt: Date;
}
