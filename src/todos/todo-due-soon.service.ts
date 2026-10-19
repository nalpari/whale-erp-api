import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  renderTemplate,
  type TemplateSource,
  type TemplateVariable,
} from '../notification-templates/render-template';
import { reasonOf } from '../notifications/ops-notification.service';
import { addDays, kstToday } from '../staff-members/kst-date';
import {
  ACTIVE_STAFF,
  dueEndsAt,
  dueKey,
  dueLabel,
  dueReminderAt,
} from './todo-rules';

const TEMPLATE_CODE = 'PUSH_TODO_DUE_SOON';
/** 미리 렌더에 쓰는 값. 템플릿의 변수 이름이 이 둘이어야 보낼 수 있다 */
const SAMPLE = {
  'TO-DO제목': '마감 정산표 확인',
  수행예정일시: '10월 8일 18:00',
};

/**
 * 수행 임박 알림 (#115, 2026-10-19 재영). 대기 · 진행 중 TO-DO 의 수행 예정 일시가 다가오면 배정된 직원에게 직원
 * 알림 하나와 앱 푸시 발송 대기 하나를 만든다. 시간이 있으면 1시간 전, 날짜만이면 그날 09:00 부터이고, 수행 예정
 * 일시가 지나면 보내지 않는다 — 처음 배포 때 지난 TO-DO 가 한꺼번에 가지 않게. 한 명 수행은 대상 전원에게 가고, 이미
 * 완료됐으면 가지 않는다. 배정 알림은 없다.
 *
 * 한 번만 — dedupe_key `todo-due-soon:<todoId>:<수행 예정 일시>:<accountId>` 의 부분 고유 인덱스에 겹치면 만들지
 * 않는다(ON CONFLICT DO NOTHING). 5분마다 돌아도, 두 인스턴스가 겹쳐도 같은 알림은 하나다. 수행 예정 일시를 고치면 키가
 * 달라 새 일시로 한 번 더 간다(T-3).
 */
@Injectable()
export class TodoDueSoonService {
  private readonly logger = new Logger(TodoDueSoonService.name);

  async notifyDueSoon(
    tx: Prisma.TransactionClient,
    now: Date = new Date(),
  ): Promise<number> {
    const today = kstToday(now);
    // 시간 있는 TO-DO 의 1시간 전은 전날일 수 있어(내일 00:30) 오늘 · 내일 것을 읽고 시각은 여기서 본다.
    const candidates = await tx.todo.findMany({
      where: {
        isDeleted: false,
        status: { in: ['PENDING', 'IN_PROGRESS'] },
        dueDate: { in: [today, addDays(today, 1)] },
      },
      select: {
        todoId: true,
        title: true,
        dueDate: true,
        dueTime: true,
        isUrgent: true,
        todoAssignees: {
          // 가입 완료(ACTIVE_STAFF)면 계정이 있지만 칸은 NULL 을 허용한다 — 받는 계정이 없는 행은 알림 수신 CHECK 를 깨므로 함께 거른다.
          where: { staffMember: { ...ACTIVE_STAFF, accountId: { not: null } } },
          select: { staffMember: { select: { accountId: true } } },
        },
      },
    });
    const targets = candidates
      .filter(
        (t) =>
          dueReminderAt(t.dueDate, t.dueTime) <= now &&
          now < dueEndsAt(t.dueDate, t.dueTime),
      )
      .flatMap((t) =>
        [...new Set(t.todoAssignees.map((a) => a.staffMember.accountId!))].map(
          (accountId) => ({
            todo: t,
            accountId,
            dedupeKey: `todo-due-soon:${t.todoId}:${dueKey(t.dueDate, t.dueTime)}:${accountId}`,
          }),
        ),
      );
    if (targets.length === 0) return 0;

    // 템플릿을 쓸 수 없으면 알림함 줄까지 만들지 않고 0 건으로 넘긴다 — 다음 실행에 다시 본다(dedupe_key 가 한 번을 지킨다).
    // 운영자가 끈 것만 warn 이고, 없거나(마이그레이션 전) 채널이 다르거나 렌더할 수 없는 것(변수를 바꿈 · 제목 없음)은
    // 고쳐야 할 일이라 error 다. 렌더 실패를 던지면 배치가 5분마다 FAILED · 롤백돼 그동안 기한이 지난 알림은 영영 안 나간다.
    // 조회의 DB 오류는 삼키지 않는다: error 로그를 남기고 던져 배치가 FAILED 로 남기고 트랜잭션째 되돌린다.
    let row: Awaited<ReturnType<typeof tx.notificationTemplate.findUnique>>;
    try {
      row = await tx.notificationTemplate.findUnique({
        where: { templateCode: TEMPLATE_CODE },
      });
    } catch (e) {
      this.logger.error(`todo due soon FAILED template lookup: ${reasonOf(e)}`);
      throw e;
    }
    if (!row || row.channel !== 'PUSH') {
      this.logger.error(
        `todo due soon SKIPPED template ${TEMPLATE_CODE}: ${row ? `channel ${row.channel}` : 'missing'}`,
      );
      return 0;
    }
    if (!row.isActive) {
      this.logger.warn(
        `todo due soon SKIPPED template ${TEMPLATE_CODE}: inactive`,
      );
      return 0;
    }
    const template: TemplateSource = {
      templateCode: TEMPLATE_CODE,
      title: row.title,
      body: row.body,
      // CHECK notification_templates_variables_array 가 배열임을 보장한다.
      variables: row.variables as TemplateVariable[],
    };
    // 미리 한 번 렌더해 본다 — 아래의 실제 값도 같은 변수 이름 · 문자열이라, 여기서 되면 거기서도 된다.
    try {
      if (renderTemplate(template, SAMPLE).subject === null)
        throw new Error('제목이 없습니다');
    } catch (e) {
      this.logger.error(
        `todo due soon SKIPPED template ${TEMPLATE_CODE}: cannot render — ${reasonOf(e)}`,
      );
      return 0;
    }

    const created = await tx.notification.createManyAndReturn({
      data: targets.map(({ todo, dedupeKey }) => {
        const { subject, body } = renderTemplate(template, {
          'TO-DO제목': todo.title,
          수행예정일시: dueLabel(todo.dueDate, todo.dueTime),
        });
        return {
          notificationTarget: 'STAFF' as const,
          templateCode: TEMPLATE_CODE,
          relatedType: 'TODO',
          relatedId: todo.todoId,
          // 미리 렌더에서 제목이 있음을 봤다
          title: subject!,
          body,
          dedupeKey,
          isUrgent: todo.isUrgent,
        };
      }),
      // 이미 보낸 것(같은 dedupe_key)은 건너뛴다
      skipDuplicates: true,
      select: { notificationId: true, dedupeKey: true },
    });
    if (created.length === 0) return 0;

    const accountOf = new Map(targets.map((t) => [t.dedupeKey, t.accountId]));
    const recipients = await tx.notificationRecipient.createManyAndReturn({
      data: created.map((n) => ({
        notificationId: n.notificationId,
        accountId: accountOf.get(n.dedupeKey!)!,
      })),
      select: { notificationRecipientId: true, accountId: true },
    });

    // 앱 푸시는 수신 설정 묶음 TO-DO 를 따른다. 설정 행이 없으면 켠 것이다. 알림함 줄은 설정과 상관없이 남는다.
    const off = await tx.notificationPreference.findMany({
      where: {
        accountId: { in: [...new Set(recipients.map((r) => r.accountId!))] },
        preferenceCategory: 'TODO',
        isEnabled: false,
      },
      select: { accountId: true },
    });
    const offAccounts = new Set(off.map((p) => p.accountId));
    const push = recipients.filter((r) => !offAccounts.has(r.accountId!));
    if (push.length > 0)
      await tx.notificationDelivery.createMany({
        data: push.map((r) => ({
          notificationRecipientId: r.notificationRecipientId,
          channel: 'PUSH' as const,
        })),
      });
    // TODO(#321): 앱 푸시 발송 자리. 발송 수단(FCM 등)과 푸시 토큰이 아직 없어 발송 대기(sent_at · result 가 빈) 행만
    // 남긴다. 발송 기반이 생기면 이 행들을 커밋 뒤에 보내고 sent_at · result 를 채운다.
    return created.length;
  }
}
