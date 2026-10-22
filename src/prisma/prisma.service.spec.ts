import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaService } from './prisma.service';

// 실제 어댑터를 만들되(연결은 하지 않는다) 생성자에 무엇이 넘어갔는지 본다.
jest.mock('@prisma/adapter-pg', () => {
  const actual =
    jest.requireActual<typeof import('@prisma/adapter-pg')>(
      '@prisma/adapter-pg',
    );
  return {
    ...actual,
    PrismaPg: jest.fn(
      (...args: ConstructorParameters<typeof actual.PrismaPg>) =>
        new actual.PrismaPg(...args),
    ),
  };
});

const PrismaPgMock = PrismaPg as unknown as jest.Mock<unknown, [unknown]>;

describe('PrismaService 생성자 — 어댑터에 세션 UTC 시작 옵션을 넘긴다', () => {
  const saved = process.env.DATABASE_URL;
  afterEach(() => {
    // undefined 를 넣으면 문자열 'undefined' 가 되므로 지운다
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
    PrismaPgMock.mockClear();
  });

  it('DATABASE_URL 을 그대로, options 로 -c TimeZone=UTC 를 넘긴다', () => {
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';
    new PrismaService();
    expect(PrismaPgMock).toHaveBeenCalledTimes(1);
    expect(PrismaPgMock.mock.calls[0][0]).toEqual({
      connectionString: 'postgresql://u:p@localhost:5432/db',
      options: '-c TimeZone=UTC',
    });
  });

  it('URL 에 ?options= 가 있어도 URL 을 다시 쓰지 않는다 — 덮어쓰기는 부팅 검사가 잡는다', () => {
    const url =
      'postgresql://u:p@localhost:5432/db?options=-c%20search_path%3Dpublic';
    process.env.DATABASE_URL = url;
    new PrismaService();
    expect(PrismaPgMock.mock.calls[0][0]).toEqual({
      connectionString: url,
      options: '-c TimeZone=UTC',
    });
  });
});

describe('PrismaService.onModuleInit — 연결한 뒤 세션 시간대를 확인한다', () => {
  const make = (timeZone: string) => {
    const service = new PrismaService();
    const connect = jest
      .spyOn(service, '$connect')
      .mockResolvedValue(undefined);
    jest.spyOn(service, '$queryRaw').mockResolvedValue([{ timeZone }] as never);
    return { service, connect };
  };

  it('UTC 면 뜬다', async () => {
    const { service, connect } = make('UTC');
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('UTC 가 아니면(URL options 덮어쓰기 · 시작 옵션 무시 등) 부팅을 멈춘다', async () => {
    const { service } = make('Asia/Seoul');
    await expect(service.onModuleInit()).rejects.toThrow(
      /세션 TimeZone 이 'Asia\/Seoul' 다/,
    );
  });
});
