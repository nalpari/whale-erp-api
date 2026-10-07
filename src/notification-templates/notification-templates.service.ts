import { Injectable, Logger } from '@nestjs/common';
import type { NotificationTemplateChannel } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { renderTemplate } from './render-template';

export type RenderedTemplate = {
  /** 알림톡만 null 이고, 다른 채널은 늘 있다. */
  title: string | null;
  body: string;
  /** 비즈뿌리오에 보내는 카카오 템플릿 코드. 알림톡 템플릿에만 있다. */
  kakaoTemplateCode: string | null;
};

/** `notification_templates.variables` 의 원소에서 치환에 쓰는 칸. */
type TemplateVariable = { name: string; isRequired: boolean };

function isVariableList(value: unknown): value is TemplateVariable[] {
  return (
    Array.isArray(value) &&
    value.every(
      (v: Partial<TemplateVariable> | null) =>
        typeof v?.name === 'string' && typeof v.isRequired === 'boolean',
    )
  );
}

/**
 * `notification_templates` 를 템플릿 코드로 읽어 `#{변수}` 를 채운다.
 * 채널별 발송 서비스(메일 · 알림톡 …)가 보내기 전에 부른다.
 *
 * 행이 발송에 맞지 않으면 이유를 로그에 남기고 던진다 — 코드가 없음, 채널이
 * 다름, 꺼짐, 제목 규칙 위반(알림톡만 제목이 없다), 알림톡의 카카오 템플릿 코드
 * 없음, 변수 목록 형식 오류, 필수 변수 값이 문자열로 오지 않음(빠졌거나 null),
 * 목록에 없는 `#{…}`. 템플릿은 운영자가 언제든 고치므로 호출부 코드와 어긋난
 * 것은 발송 때 처음 드러난다. 필수가 아닌 변수가 비면 빈 값으로 채운다.
 *
 * 행의 형식은 DB 제약과 저장 API 가 맡을 예정이지만 둘 다 아직 없고(3팀
 * 마이그레이션 전), 기본 행은 마이그레이션으로 들어와 저장 검사를 거치지 않는다.
 * 그래서 발송 때 여기서 다시 본다. 조회 자체의 DB 오류는 로그 없이 그대로 던진다.
 */
@Injectable()
export class NotificationTemplatesService {
  private readonly logger = new Logger(NotificationTemplatesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async render(
    templateCode: string,
    channel: NotificationTemplateChannel,
    variables: Record<string, string>,
  ): Promise<RenderedTemplate> {
    const template = await this.prisma.notificationTemplate.findUnique({
      where: { templateCode },
    });
    if (!template) return this.fail(templateCode, '템플릿이 없습니다');
    if (template.channel !== channel)
      return this.fail(
        templateCode,
        `${channel} 이 아니라 ${template.channel} 템플릿입니다`,
      );
    if (!template.isActive) return this.fail(templateCode, '사용 안 함');
    // 알림톡은 강조 표기형 제목을 보내지 않으므로, 제목이 있는 행은 검수 문구와 달라진다.
    if ((channel === 'ALIMTALK') !== !template.title)
      return this.fail(
        templateCode,
        channel === 'ALIMTALK' ? '알림톡에 제목이 있습니다' : '제목이 없습니다',
      );
    if (channel === 'ALIMTALK' && !template.kakaoTemplateCode)
      return this.fail(templateCode, '카카오 템플릿 코드가 없습니다');
    if (!isVariableList(template.variables))
      return this.fail(templateCode, '변수 목록 형식이 잘못됐습니다');

    const values: Record<string, string> = {};
    const missing: string[] = [];
    for (const { name, isRequired } of template.variables) {
      // 자기 키만 본다. 상속받은 toString 같은 함수가 값으로 끼어들지 않게.
      const value: unknown = Object.hasOwn(variables, name)
        ? variables[name]
        : undefined;
      if (typeof value === 'string') values[name] = value;
      else if (isRequired) missing.push(name);
      else values[name] = '';
    }
    if (missing.length)
      return this.fail(
        templateCode,
        `필수 변수가 비었습니다: ${missing.join(', ')}`,
      );

    // 목록에 없는 #{…} 가 있으면 renderTemplate 이 던진다.
    try {
      const label = `${channel} ${templateCode}`;
      return {
        title: template.title && renderTemplate(template.title, values, label),
        body: renderTemplate(template.body, values, label),
        kakaoTemplateCode: template.kakaoTemplateCode,
      };
    } catch (e) {
      return this.fail(templateCode, (e as Error).message);
    }
  }

  private fail(templateCode: string, reason: string): never {
    this.logger.warn(`template REJECTED template=${templateCode}: ${reason}`);
    throw new Error(`템플릿 ${templateCode}: ${reason}`);
  }
}
