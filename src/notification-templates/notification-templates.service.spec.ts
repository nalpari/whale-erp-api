import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationTemplatesService } from './notification-templates.service';

const row = {
  templateCode: 'EMAIL_TEMP_PASSWORD',
  channel: 'EMAIL',
  title: '#{memberName}님의 임시 비밀번호',
  body: '#{memberName}님, 임시 비밀번호는 #{password} 입니다.#{footer}',
  variables: [
    {
      name: 'memberName',
      label: '회원명',
      isRequired: true,
      sampleValue: '홍길동',
    },
    {
      name: 'password',
      label: '임시 비밀번호',
      isRequired: true,
      sampleValue: 'x',
    },
    { name: 'footer', label: '꼬리말', isRequired: false, sampleValue: '' },
  ],
  kakaoTemplateCode: null,
  isActive: true,
};

describe('NotificationTemplatesService', () => {
  let service: NotificationTemplatesService;
  let findUnique: jest.Mock;
  let logWarn: jest.SpyInstance;

  beforeEach(async () => {
    logWarn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    findUnique = jest.fn().mockResolvedValue(row);
    const module = await Test.createTestingModule({
      providers: [
        NotificationTemplatesService,
        {
          provide: PrismaService,
          useValue: { notificationTemplate: { findUnique } },
        },
      ],
    }).compile();
    service = module.get(NotificationTemplatesService);
  });

  afterEach(() => jest.restoreAllMocks());

  const vars = { memberName: '홍길동', password: 'pw-secret', footer: '!' };

  it('템플릿 코드로 읽어 제목과 본문의 변수를 채운다', async () => {
    await expect(
      service.render('EMAIL_TEMP_PASSWORD', 'EMAIL', vars),
    ).resolves.toEqual({
      title: '홍길동님의 임시 비밀번호',
      body: '홍길동님, 임시 비밀번호는 pw-secret 입니다.!',
      kakaoTemplateCode: null,
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: { templateCode: 'EMAIL_TEMP_PASSWORD' },
    });
  });

  it('필수가 아닌 변수가 비면 빈 값으로 채운다', async () => {
    const rest = { memberName: vars.memberName, password: vars.password };
    const { body } = await service.render('EMAIL_TEMP_PASSWORD', 'EMAIL', rest);

    expect(body).toBe('홍길동님, 임시 비밀번호는 pw-secret 입니다.');
  });

  it('알림톡 템플릿은 제목 없이 카카오 템플릿 코드를 돌려준다', async () => {
    findUnique.mockResolvedValue({
      ...row,
      channel: 'ALIMTALK',
      title: null,
      kakaoTemplateCode: 'WHALEERP0005',
    });

    const rendered = await service.render(
      'EMAIL_TEMP_PASSWORD',
      'ALIMTALK',
      vars,
    );

    expect(rendered.title).toBeNull();
    expect(rendered.kakaoTemplateCode).toBe('WHALEERP0005');
  });

  it.each([
    ['없는 코드', null, 'NOPE'],
    ['다른 채널', { ...row, channel: 'PUSH' }, 'PUSH'],
    ['꺼진 템플릿', { ...row, isActive: false }, '사용 안 함'],
  ])('%s 면 로그를 남기고 던진다', async (_, found, reason) => {
    findUnique.mockResolvedValue(found);

    await expect(service.render('NOPE', 'EMAIL', vars)).rejects.toThrow(reason);
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining(reason));
  });

  it.each([
    ['null', { memberName: 'x', password: null as unknown as string }],
    ['상속받은 키', Object.create({ password: 'x' }) as Record<string, string>],
  ])(
    '필수 변수 값이 문자열이 아니면(%s) 빈 것으로 보고 던진다',
    async (_, v) => {
      await expect(
        service.render('EMAIL_TEMP_PASSWORD', 'EMAIL', {
          memberName: 'x',
          ...v,
        }),
      ).rejects.toThrow('password');
    },
  );

  it('변수 목록에 없는 #{…} 가 본문에 있으면 로그를 남기고 던진다', async () => {
    // 저장 때 검사하지만, 마이그레이션이나 손으로 넣은 행은 그 검사를 거치지 않는다.
    findUnique.mockResolvedValue({ ...row, body: '#{memberName} #{unknown}' });

    await expect(
      service.render('EMAIL_TEMP_PASSWORD', 'EMAIL', vars),
    ).rejects.toThrow('unknown');
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('unknown'));
  });

  it('카카오 템플릿 코드가 없는 알림톡 행은 로그를 남기고 던진다', async () => {
    findUnique.mockResolvedValue({ ...row, channel: 'ALIMTALK', title: null });

    await expect(
      service.render('EMAIL_TEMP_PASSWORD', 'ALIMTALK', vars),
    ).rejects.toThrow('카카오 템플릿 코드');
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining('카카오 템플릿 코드'),
    );
  });

  it.each([
    ['배열이 아님', null],
    ['원소가 null', [null]],
    ['isRequired 이름이 다름', [{ name: 'password', is_required: true }]],
  ])(
    '변수 목록 형식이 잘못되면(%s) 로그를 남기고 던진다',
    async (_, variables) => {
      // 형식이 틀린 필수 변수를 선택으로 읽으면 빈 비밀번호가 나간다.
      findUnique.mockResolvedValue({ ...row, variables });

      await expect(
        service.render('EMAIL_TEMP_PASSWORD', 'EMAIL', vars),
      ).rejects.toThrow('변수 목록');
      expect(logWarn).toHaveBeenCalledWith(
        expect.stringContaining('EMAIL_TEMP_PASSWORD'),
      );
    },
  );

  it.each([
    ['제목 없는 메일', 'EMAIL', { title: null }, '제목'],
    [
      '제목 있는 알림톡',
      'ALIMTALK',
      { title: 'x', kakaoTemplateCode: 'WHALEERP0005' },
      '제목',
    ],
  ] as const)(
    '%s 행은 로그를 남기고 던진다',
    async (_, channel, patch, reason) => {
      // 알림톡은 강조 표기형 제목을 보내지 않으므로, 제목이 있는 행은 검수 문구와 달라진다.
      findUnique.mockResolvedValue({ ...row, channel, ...patch });

      await expect(
        service.render('EMAIL_TEMP_PASSWORD', channel, vars),
      ).rejects.toThrow(reason);
      expect(logWarn).toHaveBeenCalledWith(expect.stringContaining(reason));
    },
  );

  it('필수 변수의 빈 문자열은 값으로 본다', async () => {
    const { body } = await service.render('EMAIL_TEMP_PASSWORD', 'EMAIL', {
      ...vars,
      password: '',
    });

    expect(body).toBe('홍길동님, 임시 비밀번호는  입니다.!');
  });

  it('필수 변수가 비면 이름을 담아 로그를 남기고 던진다', async () => {
    await expect(
      service.render('EMAIL_TEMP_PASSWORD', 'EMAIL', { memberName: 'x' }),
    ).rejects.toThrow('password');
    const [line] = logWarn.mock.calls[0] as [string];
    expect(line).toContain('password');
    expect(line).toContain('EMAIL_TEMP_PASSWORD');
  });

  it('변수 목록에 없는 값은 무시하고, 값을 로그에 남기지 않는다', async () => {
    await service.render('EMAIL_TEMP_PASSWORD', 'EMAIL', {
      ...vars,
      extra: 'y',
    });
    await service
      .render('EMAIL_TEMP_PASSWORD', 'EMAIL', { password: 'pw-secret' })
      .catch(() => {});

    for (const [line] of logWarn.mock.calls as [string][])
      expect(line).not.toContain('pw-secret');
  });
});
