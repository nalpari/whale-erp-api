import type { PrismaService } from '../prisma/prisma.service';
import { findSendableTemplate } from './find-template';

describe('findSendableTemplate', () => {
  const row = {
    notificationTemplateId: 1,
    templateCode: 'TALK_STAFF_INVITATION',
    channel: 'ALIMTALK',
    templateName: '가입 초대',
    preferenceCategory: null,
    title: null,
    body: '#{근무지}에서 초대합니다',
    variables: [{ name: '근무지', isRequired: true }],
    kakaoTemplateCode: 'WHALE_INVITE_01',
    isActive: true,
  };
  let findUnique: jest.Mock;
  const find = (channel: 'ALIMTALK' | 'EMAIL' = 'ALIMTALK') =>
    findSendableTemplate(
      { notificationTemplate: { findUnique } } as unknown as Pick<
        PrismaService,
        'notificationTemplate'
      >,
      'TALK_STAFF_INVITATION',
      channel,
    );

  beforeEach(() => {
    findUnique = jest.fn().mockResolvedValue(row);
  });

  it('템플릿 코드로 조회해 렌더에 필요한 모양으로 돌려준다', async () => {
    await expect(find()).resolves.toEqual({
      templateCode: 'TALK_STAFF_INVITATION',
      title: null,
      body: '#{근무지}에서 초대합니다',
      variables: [{ name: '근무지', isRequired: true }],
      kakaoTemplateCode: 'WHALE_INVITE_01',
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: { templateCode: 'TALK_STAFF_INVITATION' },
    });
  });

  it('없으면 코드를 담아 던진다', async () => {
    findUnique.mockResolvedValue(null);

    await expect(find()).rejects.toThrow(/TALK_STAFF_INVITATION.*없습니다/);
  });

  it('사용하지 않는 템플릿이면 그 사실을 담아 던진다', async () => {
    findUnique.mockResolvedValue({ ...row, isActive: false });

    await expect(find()).rejects.toThrow(
      /TALK_STAFF_INVITATION.*사용하지 않는/,
    );
  });

  it('채널이 다르면 두 채널을 담아 던진다', async () => {
    await expect(find('EMAIL')).rejects.toThrow(
      /TALK_STAFF_INVITATION.*EMAIL.*ALIMTALK/,
    );
  });
});
