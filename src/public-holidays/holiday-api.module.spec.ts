import { type DynamicModule, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { HolidayApiClient } from './holiday-api.client';
import { HolidayApiModule } from './holiday-api.module';

// 공휴일 API 키는 국세청 키처럼 선택 설정이다 — 없어도 api 는 뜨고, 동기화 배치만 실패 이력을 남긴다.
// 운영에서 비어 있으면 기동 때 error 로 남겨 배포 로그에서 알게 한다.
describe('HolidayApiModule', () => {
  const before = process.env.APP_ENV;
  let error: jest.SpyInstance;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (before === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = before;
  });

  // 실제 앱은 전역 ConfigModule 이 ConfigService 를 준다. 테스트는 같은 자리에 가짜 전역 모듈을 둔다.
  const build = async (key: string | undefined) => {
    const config: DynamicModule = {
      module: class FakeConfigModule {},
      global: true,
      providers: [
        {
          provide: ConfigService,
          useValue: {
            get: (k: string) => (k === 'HOLIDAY_SERVICE_KEY' ? key : undefined),
          },
        },
      ],
      exports: [ConfigService],
    };
    const moduleRef = await Test.createTestingModule({
      imports: [config, HolidayApiModule],
    }).compile();
    return moduleRef.get(HolidayApiClient);
  };

  it('운영에서 키가 없어도 기동한다 — 기동 때 error 로 남긴다', async () => {
    process.env.APP_ENV = 'prod';
    const client = await build(undefined);
    expect(client.isConfigured).toBe(false);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('HOLIDAY_SERVICE_KEY'),
    );
  });

  it('운영이 아니면 경고만 남긴다 — 공백뿐인 값도 없는 것이다', async () => {
    process.env.APP_ENV = 'local';
    const client = await build('   ');
    expect(client.isConfigured).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('HOLIDAY_SERVICE_KEY'),
    );
    expect(error).not.toHaveBeenCalled();
  });

  it('키가 있으면 아무것도 남기지 않는다', async () => {
    process.env.APP_ENV = 'prod';
    const client = await build('service-key');
    expect(client.isConfigured).toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
