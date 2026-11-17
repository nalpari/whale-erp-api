import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isProduction } from '../config/profile';
import { NtsBusinessClient } from './nts-business.client';

/**
 * 개발서버 시험용 통과 모드(NTS_VERIFICATION_BYPASS=true, 2026-11-17 front 요청). 국세청을 부르지 않고 어떤 값이든
 * 일치로 본다. 입력 검사 · 사업자등록번호 중복 검사 · 요청 제한, 회원가입 · MY PAGE · BP 마스터의 10분 인증 토큰과
 * 점포의 10분 재사용은 호출하는 쪽에 있어 그대로 돈다. 키가 없어도 「설정됨」이라 점포도 503 이 아니다.
 * 운영에서는 NtsModule 이 이것을 만들지 않는다.
 * 부모에는 키를 undefined 로 넘기고 isConfigured · verify 만 덮는다 — 부모에 키를 직접 보는 메서드가 새로 생기면
 * 통과 모드에서 그 메서드는 「키 없음」으로 동작하니 여기서도 덮는다.
 */
export class BypassNtsBusinessClient extends NtsBusinessClient {
  private readonly logger = new Logger('NtsModule');

  constructor() {
    super(undefined);
  }

  override get isConfigured(): boolean {
    return true;
  }

  // 받은 값은 보지도 남기지도 않는다 — 대표자명 · 번호는 개인정보다.
  override verify(): Promise<'MATCH' | 'MISMATCH'> {
    this.logger.warn(
      '사업자 진위확인 통과 모드 — 국세청을 건너뜀(NTS_VERIFICATION_BYPASS)',
    );
    return Promise.resolve('MATCH');
  }
}

/** 값을 읽어 켜짐 · 꺼짐 · 알아보지 못함으로 나눈다. 대소문자 · 앞뒤 공백은 무시하고, 비어 있으면 꺼짐이다 */
function bypassSetting(
  value: string | undefined,
): 'on' | 'off' | 'unrecognized' {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'true') return 'on';
  if (!normalized || normalized === 'false') return 'off';
  return 'unrecognized';
}

// 국세청 진위확인 클라이언트. 회원가입(AdminSignupModule) · MY PAGE BP 사업자정보(AuthModule) · BP 마스터
// (BpMastersModule) · 점포(StoresModule)가 같이 쓴다.
//
// 키(NTS_SERVICE_KEY)는 메일 · 점포 사업자 인증처럼 선택 설정이다(2026-10-15 결정) — 없으면 api 는 뜨고
// 사업자 진위확인만 503 이 된다(가입은 인증 없이 된다, 아래 통과 모드는 예외). 운영에서 비어 있으면 기동 때
// error 로 남겨 배포 로그에서 알게 하고, 그 밖에서는 경고만 남긴다. 키가 빠진 배포가 통째로 뜨지 않는 것보다 낫다.
//
// NTS_VERIFICATION_BYPASS=true 면 운영이 아닐 때만 통과 모드다. 운영 환경 파일에 실수로 들어가도 진짜 검사가
// 돌게 무시하고 error 로 남긴다. true · false · 빈 값이 아니면 꺼짐으로 보되, 「켰는데 안 된다」를 알 수 있게
// 기동 때 경고한다.
@Module({
  providers: [
    {
      provide: NtsBusinessClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const logger = new Logger('NtsModule');
        const bypass = bypassSetting(
          config.get<string>('NTS_VERIFICATION_BYPASS'),
        );
        if (bypass === 'unrecognized')
          logger.warn(
            'NTS_VERIFICATION_BYPASS 값을 알아보지 못해 꺼짐으로 봅니다 — 켜려면 true 를 넣습니다',
          );
        if (bypass === 'on') {
          if (!isProduction()) {
            logger.warn(
              '사업자 진위확인 통과 모드 — 국세청을 건너뛰고 어떤 값이든 일치로 봅니다(NTS_VERIFICATION_BYPASS, 개발 시험용)',
            );
            return new BypassNtsBusinessClient();
          }
          logger.error(
            'NTS_VERIFICATION_BYPASS 가 운영에서 켜져 있습니다 — 무시하고 국세청 진위확인을 그대로 합니다',
          );
        }
        const key = config.get<string>('NTS_SERVICE_KEY')?.trim();
        if (!key) {
          const message =
            'NTS_SERVICE_KEY 가 없습니다 — 회원가입 · 점포의 사업자 진위확인은 503 입니다';
          if (isProduction()) logger.error(message);
          else logger.warn(message);
        }
        return new NtsBusinessClient(key);
      },
    },
  ],
  exports: [NtsBusinessClient],
})
export class NtsModule {}
