import { type DynamicModule, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { storeBusinessVerifierFor } from '../stores/nts-store-business-verifier';
import { NtsBusinessClient } from './nts-business.client';
import { BypassNtsBusinessClient, NtsModule } from './nts.module';

// 국세청 키는 선택 설정이다 — 메일 · 점포 사업자 인증처럼, 없어도 api 는 뜨고 진위확인만 503 이 된다
// (2026-10-15 결정). 운영에서 비어 있으면 기동 때 error 로 남겨 배포 로그에서 알게 한다.
describe('NtsModule', () => {
  const appEnv = process.env.APP_ENV;
  const nodeEnv = process.env.NODE_ENV;
  let error: jest.SpyInstance;
  let warn: jest.SpyInstance;

  const restore = (name: 'APP_ENV' | 'NODE_ENV', value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  beforeEach(() => {
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    // 운영 판정(isProduction)은 NODE_ENV 도 본다 — 바깥에서 무엇으로 돌리든 시험마다 같은 출발점에서 본다.
    delete process.env.NODE_ENV;
  });
  afterEach(() => {
    jest.restoreAllMocks();
    restore('APP_ENV', appEnv);
    restore('NODE_ENV', nodeEnv);
  });

  // 실제 앱은 전역 ConfigModule 이 ConfigService 를 준다. 테스트는 같은 자리에 가짜 전역 모듈을 둔다.
  const build = async (
    key: string | undefined,
    bypass: string | undefined = undefined,
  ) => {
    const config: DynamicModule = {
      module: class FakeConfigModule {},
      global: true,
      providers: [
        {
          provide: ConfigService,
          useValue: {
            get: (k: string) =>
              k === 'NTS_SERVICE_KEY'
                ? key
                : k === 'NTS_VERIFICATION_BYPASS'
                  ? bypass
                  : undefined,
          },
        },
      ],
      exports: [ConfigService],
    };
    const moduleRef = await Test.createTestingModule({
      imports: [config, NtsModule],
    }).compile();
    return moduleRef.get(NtsBusinessClient);
  };

  it('운영에서 키가 없어도 기동한다 — 진위확인만 503 이 되고 기동 때 error 로 남긴다', async () => {
    process.env.APP_ENV = 'prod';
    const client = await build(undefined);
    expect(client.isConfigured).toBe(false);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('NTS_SERVICE_KEY'),
    );
  });

  it('운영이 아니면 경고만 남긴다', async () => {
    process.env.APP_ENV = 'local';
    const client = await build('');
    expect(client.isConfigured).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('NTS_SERVICE_KEY'),
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

  // 개발서버 시험용(2026-11-17 front 요청) — 국세청을 건너뛰고 어떤 값이든 일치로 본다. 운영에서는 무시한다.
  describe('NTS_VERIFICATION_BYPASS', () => {
    const identity = {
      bizRegistrationNumber: '1234567890',
      bizCeoName: '홍길동',
      bizOpenDate: '2000-01-01',
    };
    // 클라이언트는 만들 때 fetch 를 잡아 두므로, 국세청을 부르면 안 되는 시험은 만들기 전에 가짜 fetch 를 건다.
    const blockFetch = () =>
      jest
        .spyOn(global, 'fetch')
        .mockRejectedValue(new Error('국세청을 부르면 안 된다'));

    it('true 면 키가 없어도 설정된 것으로 보고 어떤 값이든 MATCH 다 — 기동 때와 확인할 때마다 경고를 남긴다', async () => {
      process.env.APP_ENV = 'dev';
      const fetchFn = blockFetch();
      const client = await build(undefined, 'true');
      expect(client.isConfigured).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('사업자 진위확인 통과 모드'),
      );
      warn.mockClear();
      await expect(client.verify(identity)).resolves.toBe('MATCH');
      await expect(client.verify(identity)).resolves.toBe('MATCH');
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('국세청을 건너뜀'),
      );
      expect(fetchFn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    });

    it('로그에 사업자등록번호 · 대표자명을 남기지 않는다', async () => {
      process.env.APP_ENV = 'dev';
      blockFetch();
      const client = await build(undefined, 'true');
      await client.verify(identity);
      const calls = (warn.mock.calls as unknown[][]).concat(
        error.mock.calls as unknown[][],
      );
      const logged = calls.flat().map(String).join(' ');
      expect(logged).not.toContain(identity.bizRegistrationNumber);
      expect(logged).not.toContain(identity.bizCeoName);
    });

    it('키가 있어도 국세청을 부르지 않는다', async () => {
      process.env.APP_ENV = 'local';
      const fetchFn = blockFetch();
      const client = await build('service-key', ' TRUE ');
      await expect(client.verify(identity)).resolves.toBe('MATCH');
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('점포의 진위확인도 503 대신 통과한다', async () => {
      process.env.APP_ENV = 'dev';
      blockFetch();
      const verifier = storeBusinessVerifierFor(await build(undefined, 'true'));
      expect(verifier).not.toBeNull();
      await expect(
        verifier!.verify({
          bizRegistrationNumber: identity.bizRegistrationNumber,
          ceoName: identity.bizCeoName,
          openDate: new Date('2000-01-01T00:00:00Z'),
        }),
      ).resolves.toBe(true);
    });

    it.each([
      ['APP_ENV=prod', { APP_ENV: 'prod' }],
      ['NODE_ENV=production', { APP_ENV: 'dev', NODE_ENV: 'production' }],
    ])(
      '운영(%s)이면 켜져 있어도 무시하고 기동 때 error 를 남긴다',
      async (_, env: Record<string, string>) => {
        Object.assign(process.env, env);
        const client = await build(undefined, 'true');
        expect(client.isConfigured).toBe(false);
        await expect(client.verify(identity)).rejects.toThrow(
          'NTS_SERVICE_KEY',
        );
        expect(error).toHaveBeenCalledWith(
          expect.stringContaining('NTS_VERIFICATION_BYPASS'),
        );
        expect(warn).not.toHaveBeenCalledWith(
          expect.stringContaining('통과 모드'),
        );

        // 키가 있으면 진짜 클라이언트로 국세청을 부른다 — 통과 모드 클라이언트가 아니다.
        const fetchFn = jest
          .spyOn(global, 'fetch')
          .mockRejectedValue(new Error('network'));
        const withKey = await build('service-key', 'true');
        expect(withKey.isConfigured).toBe(true);
        expect(withKey).not.toBeInstanceOf(BypassNtsBusinessClient);
        await expect(withKey.verify(identity)).rejects.toThrow(
          '국세청 호출 실패',
        );
        expect(fetchFn).toHaveBeenCalledTimes(1);
      },
    );

    it.each([[undefined], [''], ['false'], [' FALSE ']])(
      '%p 이면 꺼짐이다 — 키가 없으면 그대로 503 이고 따로 알리지 않는다',
      async (value) => {
        process.env.APP_ENV = 'local';
        const client = await build(undefined, value);
        expect(client.isConfigured).toBe(false);
        await expect(client.verify(identity)).rejects.toThrow(
          'NTS_SERVICE_KEY',
        );
        expect(warn).not.toHaveBeenCalledWith(
          expect.stringContaining('NTS_VERIFICATION_BYPASS'),
        );
      },
    );

    // 「켰는데 안 된다」를 로그로 알 수 있게 — 꺼짐으로 보되 기동 때 알린다.
    it.each([['1'], ['yes'], ['on'], ['True1']])(
      '%p 처럼 알아보지 못하는 값은 꺼짐으로 보고 기동 때 경고한다',
      async (value) => {
        process.env.APP_ENV = 'local';
        const client = await build(undefined, value);
        expect(client.isConfigured).toBe(false);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('알아보지 못해 꺼짐'),
        );
        expect(warn).not.toHaveBeenCalledWith(
          expect.stringContaining('통과 모드 —'),
        );
      },
    );
  });
});
