import { applyDecorators, type Logger } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, ValidateIf } from 'class-validator';
import { HQ_SHARING_CONSENT_VERSION } from '../admin-scope/hq-sharing';

/** 본사 제공 동의를 묻는 점포인가 — 직영이 아니면(모르는 유형 포함) 묻는다. 가림(hidesPersonalData)과 같은 기준이다 */
export const asksHqSharingConsentAt = (storeTypeCode: string | undefined) =>
  storeTypeCode !== 'DIRECT';

/** 동의 문구 버전 칸의 길이 상한 — 버전 칸은 길이 제한이 없다. 「v1.0」 꼴보다 넉넉히, 위치정보 동의와 같다 */
export const CONSENT_VERSION_MAX = 64;

const VERSION_INVALID =
  '동의 문구 버전(hqSharingConsentVersion)은 비지 않은 문자열이어야 합니다.';

/**
 * 가입 · 근무지 더하기 · 소속 추가 수락의 `hqSharingConsentVersion` 칸(ATT-30 v252). `hqSharingConsented` 가 true 이고 칸이 있을
 * 때만 형식을 본다. 빠져도 400 이 아니다 — 버전을 싣지 않는 예전 앱(배포 어긋남)의 동의는 「버전이 다르다」와 같게 남기지 않고
 * 가입 · 수락은 마친다(v253 — 동의는 선택이라 가입 · 수락을 막지 않는다, hqSharingConsentRecordOf). 동의하지 않으면 보내도 보지
 * 않고 쓰지 않는다. 내 정보의 동의(consentVersion)와 같은 64자 상한이다
 */
export function IsHqSharingConsentVersion(): PropertyDecorator {
  return applyDecorators(
    // Swagger 플러그인은 소스의 검증 데코레이터만 읽어 여기 감춘 것은 못 본다 — 길이는 직접 적는다(IsUpdatedAt 과 같다)
    ApiPropertyOptional({ minLength: 1, maxLength: CONSENT_VERSION_MAX }),
    ValidateIf(
      (o: {
        hqSharingConsented?: unknown;
        hqSharingConsentVersion?: unknown;
      }) =>
        // null 도 빠진 것과 같다 — 버전을 null 로 싣는 앱도 가입 · 수락이 막히지 않게(v253)
        o.hqSharingConsented === true && o.hqSharingConsentVersion != null,
    ),
    IsString({ message: VERSION_INVALID }),
    IsNotEmpty({ message: VERSION_INVALID }),
    MaxLength(CONSENT_VERSION_MAX, {
      message: '동의 문구 버전(hqSharingConsentVersion)은 64자 이하입니다.',
    }),
  );
}

/**
 * 가입 · 수락에서 본사 제공 동의를 남길지(ATT-30 v253, 2026-10-29 재영). 본사 제공 동의는 선택이라 화면이 보인 문구 버전이
 * 지금 것과 달라도 가입 · 수락은 막지 않고 동의만 남기지 않는다 — 계정의 동의는 그대로 두고, 앱이 완료 화면에서 내 정보에서
 * 다시 동의하라고 알린다. 응답의 `hqSharingConsentRecorded` 값이다.
 * - null: 남길 동의가 없다 — 묻지 않는 경우(`asked` 가 거짓: 직영 점포 · 이미 지금 받아 주는 버전에 동의함)이거나 동의하지 않음
 * - true: 남긴다
 * - false: 동의했지만 보인 문구 버전이 지금과 다르거나 싣지 않아(예전 앱) 남기지 않는다
 */
export function hqSharingConsentRecordOf(
  asked: boolean,
  dto: {
    hqSharingConsented?: boolean;
    hqSharingConsentVersion?: string | null;
  },
): boolean | null {
  if (!asked || dto.hqSharingConsented !== true) return null;
  return dto.hqSharingConsentVersion === HQ_SHARING_CONSENT_VERSION;
}

/**
 * 보인 문구 버전이 달라(또는 싣지 않아) 본사 제공 동의를 남기지 않았다 — 오래 열어 둔 화면 · 배포 어긋남을 로그에서 찾게 남긴다
 * (ATT-30 v253). 보낸 값은 공개 경로에서 오므로 JSON 으로 감싸 줄바꿈 · 제어 문자가 로그 줄을 꾸미지 못하게 한다
 */
export function warnStaleHqSharingVersion(
  logger: Logger,
  flow: string,
  accountId: number,
  dto: { hqSharingConsentVersion?: string | null },
  recorded: boolean | null,
): void {
  // 남기지 않았을 때(false)만 — 흐름마다 같은 조건을 되풀이하지 않게 여기서 본다
  if (recorded !== false) return;
  logger.warn(
    `${flow}: 화면이 보인 본사 제공 동의 문구 버전이 지금과 달라 동의를 남기지 않았다 accountId=${accountId} shown=${dto.hqSharingConsentVersion == null ? 'none' : JSON.stringify(dto.hqSharingConsentVersion)} current=${HQ_SHARING_CONSENT_VERSION}`,
  );
}
