import { applyDecorators, type Logger } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, ValidateIf } from 'class-validator';
import { HQ_SHARING_CONSENT_VERSION } from '../admin-scope/hq-sharing';

/** 본사 제공 동의를 묻는 점포인가 — 직영이 아니면(모르는 유형 포함) 묻는다. 가림(hidesPersonalData)과 같은 기준이다 */
export const asksHqSharingConsentAt = (storeTypeCode: string | undefined) =>
  storeTypeCode !== 'DIRECT';

const VERSION_MISSING =
  '본사 제공 동의에 화면이 보인 동의 문구 버전(hqSharingConsentVersion)을 함께 보내 주세요.';

/**
 * 가입 · 근무지 더하기 · 소속 추가 수락의 `hqSharingConsentVersion` 칸(ATT-30 v252). `hqSharingConsented` 가 true 일 때만
 * 보고 그때는 반드시 있어야 한다(없으면 400 — 버전을 싣지 않는 예전 앱이 예전 문구로 받은 동의를 지금 버전으로 남기지 못하게).
 * 동의하지 않으면 보내도 보지 않고 쓰지 않는다. 내 정보의 동의(consentVersion)와 같은 64자 상한이다
 */
export function IsHqSharingConsentVersion(): PropertyDecorator {
  return applyDecorators(
    // Swagger 플러그인은 소스의 검증 데코레이터만 읽어 여기 감춘 것은 못 본다 — 길이는 직접 적는다(IsUpdatedAt 과 같다)
    ApiPropertyOptional({ minLength: 1, maxLength: 64 }),
    ValidateIf(
      (o: { hqSharingConsented?: unknown }) => o.hqSharingConsented === true,
    ),
    IsString({ message: VERSION_MISSING }),
    IsNotEmpty({ message: VERSION_MISSING }),
    MaxLength(64, {
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
 * - false: 동의했지만 보인 문구 버전이 지금과 달라 남기지 않는다
 */
export function hqSharingConsentRecordOf(
  asked: boolean,
  dto: { hqSharingConsented?: boolean; hqSharingConsentVersion?: string },
): boolean | null {
  if (!asked || dto.hqSharingConsented !== true) return null;
  return dto.hqSharingConsentVersion === HQ_SHARING_CONSENT_VERSION;
}

/** 보인 문구 버전이 달라 본사 제공 동의를 남기지 않았다 — 오래 열어 둔 화면 · 배포 어긋남을 로그에서 찾게 남긴다(ATT-30 v253) */
export function warnStaleHqSharingVersion(
  logger: Logger,
  flow: string,
  accountId: number,
  dto: { hqSharingConsentVersion?: string },
): void {
  logger.warn(
    `${flow}: 화면이 보인 본사 제공 동의 문구 버전이 지금과 달라 동의를 남기지 않았다 accountId=${accountId} shown=${dto.hqSharingConsentVersion} current=${HQ_SHARING_CONSENT_VERSION}`,
  );
}
