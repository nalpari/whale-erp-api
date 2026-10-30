import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  renderTemplate,
  type TemplateSource,
  type TemplateVariable,
} from '../notification-templates/render-template';
import { errorKind } from '../common/error-kind';
import type { OptionalMailService } from '../mail/mail.module';
import { isMailTransportError } from '../mail/mail.service';
import { reasonOf } from '../notifications/ops-notification.service';
import type { PrismaService } from '../prisma/prisma.service';
import { kstTimeOf, type Span, workDateOf } from './work-schedule-rules';

const TEMPLATE_CODE = 'PUSH_SCHEDULE_CHANGED';
const MAIL_TEMPLATE_CODE = 'EMAIL_SCHEDULE_CHANGED';
/** 메일 버튼이 여는 직원 근무 앱 근무 탭 */
const STAFF_APP_WORK_PATH = '/work';
/** 저장 알림이 근무스케줄을 가리키는 related_type — 파기 배치가 같은 값으로 지운다 */
export const RELATED_TYPE = 'WORK_SCHEDULE';
const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

/** 「10월 21일(수) 09:00~18:00」 — 자정을 넘으면 「22:00~익일 02:00」, 날짜를 뺄 수 있다 */
function labelOf(span: Span, withDate = true): string {
  const day = workDateOf(span.startAt);
  const endTime = kstTimeOf(span.endAt);
  const end =
    workDateOf(span.endAt).getTime() === day.getTime()
      ? endTime
      : endTime === '00:00'
        ? '24:00'
        : `익일 ${endTime}`;
  const date = `${day.getUTCMonth() + 1}월 ${day.getUTCDate()}일(${WEEKDAY[day.getUTCDay()]}) `;
  return `${withDate ? date : ''}${kstTimeOf(span.startAt)}~${end}`;
}

/** 근무 시각과 휴게(분) */
type Shift = Span & { breakMinutes: number };

export type ScheduleChange =
  | { kind: 'CREATED'; after: Shift }
  | { kind: 'UPDATED'; before: Shift; after: Shift }
  | { kind: 'DELETED'; before: Shift };

/**
 * 템플릿의 #{변경내용}(2026-10-21 재영 Q7). 등록 「10월 21일(수) 09:00~18:00 추가」, 삭제 「… 삭제」, 수정은 「전 → 후」이고
 * 근무일이 같으면 뒤쪽 날짜를 뺀다(템플릿 예시 「10월 9일(목) 09:00~15:00 → 12:00~18:00」과 같은 꼴). 시각이 같고 휴게만
 * 바뀌면 「10월 21일(수) 09:00~13:00 휴게 30분 → 60분」. 시각과 휴게가 함께 바뀌면 시각 변화만 적는다.
 */
export function changeText(change: ScheduleChange): string {
  switch (change.kind) {
    case 'CREATED':
      return `${labelOf(change.after)} 추가`;
    case 'DELETED':
      return `${labelOf(change.before)} 삭제`;
    case 'UPDATED': {
      const { before, after } = change;
      if (
        before.startAt.getTime() === after.startAt.getTime() &&
        before.endAt.getTime() === after.endAt.getTime()
      )
        return `${labelOf(before)} 휴게 ${before.breakMinutes}분 → ${after.breakMinutes}분`;
      const sameDay =
        workDateOf(change.before.startAt).getTime() ===
        workDateOf(change.after.startAt).getTime();
      return `${labelOf(change.before)} → ${labelOf(change.after, !sameDay)}`;
    }
  }
}

/** 변경의 시작 시각 — 등록 · 수정은 변경 후, 삭제는 변경 전 */
const startOf = (c: ScheduleChange) =>
  c.kind === 'DELETED' ? c.before.startAt : c.after.startAt;

/** 수정인데 시작 · 종료 · 휴게가 모두 같다 */
function isUnchanged(change: ScheduleChange): boolean {
  return (
    change.kind === 'UPDATED' &&
    change.before.startAt.getTime() === change.after.startAt.getTime() &&
    change.before.endAt.getTime() === change.after.endAt.getTime() &&
    change.before.breakMinutes === change.after.breakMinutes
  );
}

/** 커밋 뒤에 보낼 근무스케줄 변경 메일(WHALEERP-639) — 링크는 보낼 때 붙인다 */
export type ScheduleMail = {
  notificationRecipientId: number;
  to: string;
  variables: { 근무지: string; 변경내용: string };
};

/**
 * 근무스케줄 저장 알림(#201, STAFF-15). 저장 한 번에 바뀐 직원에게 직원 알림 하나와 앱 푸시 발송 대기 하나를 만든다 —
 * 저장 트랜잭션 안에서 부른다(저장이 되돌려지면 알림도 없다). 시간과 관계없이 곧바로다. 템플릿의 수신 설정 묶음(기본 「근무스케줄」)을
 * 끈 직원은 앱 푸시 없이 알림함에만 남는다(NTF-14). 퇴직 처리가 지울 때는 부르지 않는다(PAY-14).
 *
 * 템플릿을 쓸 수 없으면(없음 · 채널이 다름 · 사용 안 함 · 렌더 실패) 알림 없이 저장만 한다 — 운영자가 템플릿을 잘못
 * 고쳐도 관리자의 저장이 막히면 안 된다. 사용 안 함만 warn 이고 나머지는 고쳐야 할 일이라 error 다. DB 오류는 던진다.
 * 수행 임박 알림(src/todos/todo-due-soon.service.ts)과 같은 순서다.
 *
 * 앱 푸시 발송 대기를 만들었으면(수신 설정 묶음을 끄지 않음) 같은 내용의 메일을 돌려준다(WHALEERP-639, 운영 정책 NTF-14 ·
 * NTF-18) — 메일은 되돌릴 수 없어 부르는 쪽이 커밋 뒤에 sendScheduleMail 로 보낸다. 메일 템플릿에는 묶음을 둘 수 없어(CHECK
 * notification_templates_preference_category_push_only) 앱 푸시의 판정을 따른다.
 */
export async function noticeScheduleChange(
  tx: Prisma.TransactionClient,
  logger: Logger,
  input: {
    staffMemberId: number;
    /** 알림이 가리킬 근무스케줄 — 여러 건이면 첫 건 */
    workScheduleId: number;
    /** 이번 저장에서 그 직원에게 생긴 변경. 일괄 등록은 여러 건을 알림 하나로 묶는다(저장 한 번에 직원마다 한 번, #201) */
    changes: ScheduleChange[];
  },
): Promise<ScheduleMail | null> {
  // 시작 · 종료 · 휴게가 모두 같은 수정은 바뀐 것이 없다 — 알리지 않는다(변경 이력은 저장 쪽이 남긴다, api #106 리뷰)
  const changes = input.changes.filter((c) => !isUnchanged(c));
  if (changes.length === 0) return null;
  const staff = await tx.staffMember.findUnique({
    where: { staffMemberId: input.staffMemberId },
    select: {
      storeId: true,
      employmentStatus: true,
      account: { select: { accountId: true, status: true, email: true } },
    },
  });
  // 근무스케줄은 가입한 직원만 받지만 칸은 NULL 을 허용한다 — 받을 계정이 없거나 탈퇴했으면 보낼 곳이 없다(급여명세서 발송과
  // 같다). 보내지 않은 사실은 로그로 남긴다(운영 정책 NTF-25)
  // 퇴직한 직원(재직이 아닌 레코드)의 지난 근무스케줄을 고치거나 지울 때도 알리지 않는다(운영 정책 PAY-14 v185,
  // 2026-10-21 재영). 퇴직 예정(퇴직일까지 재직)은 알린다
  if (staff && staff.employmentStatus !== 'EMPLOYED') {
    logger.warn(
      `work schedule notice SKIPPED staffMember ${input.staffMemberId}: ${staff.employmentStatus}`,
    );
    return null;
  }
  const account = staff?.account;
  if (!account || account.status === 'WITHDRAWN') {
    logger.warn(
      `work schedule notice SKIPPED staffMember ${input.staffMemberId}: ${account ? 'withdrawn account' : 'no account'}`,
    );
    return null;
  }
  // 점포는 1팀 표라 직원 레코드에서 관계로 닿지 않는다. 이름이 없으면 본문의 근무지 자리(「#{근무지} 근무스케줄이 변경되었습니다.」)가 빈칸이 되니 보내지 않는다
  const store = await tx.store.findUnique({
    where: { storeId: staff.storeId },
    select: { name: true },
  });
  if (!store?.name) {
    logger.error(
      `work schedule notice SKIPPED staffMember ${input.staffMemberId}: store ${staff.storeId} ${store ? 'has no name' : 'missing'}`,
    );
    return null;
  }

  const row = await tx.notificationTemplate.findUnique({
    where: { templateCode: TEMPLATE_CODE },
  });
  if (!row || row.channel !== 'PUSH') {
    logger.error(
      `work schedule notice SKIPPED template ${TEMPLATE_CODE}: ${row ? `channel ${row.channel}` : 'missing'}`,
    );
    return null;
  }
  if (!row.isActive) {
    logger.warn(
      `work schedule notice SKIPPED template ${TEMPLATE_CODE}: inactive`,
    );
    return null;
  }
  const template: TemplateSource = {
    templateCode: TEMPLATE_CODE,
    title: row.title,
    body: row.body,
    // CHECK notification_templates_variables_array 가 배열임을 보장한다.
    variables: row.variables as TemplateVariable[],
  };
  const variables = {
    근무지: store.name,
    // 여러 건은 시작 시각순으로 잇는다(삭제는 변경 전 시각)
    변경내용: [...changes]
      .sort((a, b) => startOf(a).getTime() - startOf(b).getTime())
      .map(changeText)
      .join(', '),
  };
  let rendered: { subject: string | null; body: string };
  try {
    rendered = renderTemplate(template, variables);
    if (rendered.subject === null) throw new Error('제목이 없습니다');
  } catch (e) {
    logger.error(
      `work schedule notice SKIPPED template ${TEMPLATE_CODE}: cannot render — ${reasonOf(e)}`,
    );
    return null;
  }

  const notification = await tx.notification.create({
    data: {
      notificationTarget: 'STAFF',
      templateCode: TEMPLATE_CODE,
      relatedType: RELATED_TYPE,
      relatedId: input.workScheduleId,
      title: rendered.subject,
      body: rendered.body,
    },
    select: { notificationId: true },
  });
  const recipient = await tx.notificationRecipient.create({
    data: {
      notificationId: notification.notificationId,
      accountId: account.accountId,
    },
    select: { notificationRecipientId: true },
  });
  // 묶음은 템플릿 값을 따른다 — 운영자가 템플릿 관리에서 바꿀 수 있다. PUSH 템플릿이면 CHECK
  // notification_templates_preference_category_push_only 가 값이 있음을 보장한다. 설정 행이 없으면 켠 것이고, 알림함
  // 줄은 설정과 상관없이 남는다
  const off = await tx.notificationPreference.findFirst({
    where: {
      accountId: account.accountId,
      preferenceCategory: row.preferenceCategory!,
      isEnabled: false,
    },
    select: { accountId: true },
  });
  if (off) return null;
  await tx.notificationDelivery.create({
    data: {
      notificationRecipientId: recipient.notificationRecipientId,
      channel: 'PUSH',
    },
  });
  // TODO(#321): 앱 푸시 발송 자리 — 수행 임박 알림과 같이 발송 대기 행만 남긴다
  return {
    notificationRecipientId: recipient.notificationRecipientId,
    to: account.email,
    variables,
  };
}

/**
 * 커밋 뒤 근무스케줄 변경 메일 한 통(WHALEERP-639). 던지지 않는다 — 저장은 이미 끝났다. 메일 설정(MAIL_*) · 직원 앱 주소
 * (STAFF_APP_URL)가 없으면 보내지 않고 로그만 남긴다(알림함 줄은 남아 있다). 발송 이력은 notification_deliveries 의 EMAIL 행 —
 * 보냈으면 sent_at · SUCCEEDED, SMTP 실패면 FAILED. 보내기 전에 막힌 것(템플릿 꺼짐 · 주소 형식)은 보낸 것이 없어 로그만이다.
 */
export async function sendScheduleMail(
  deps: {
    prisma: PrismaService;
    mail: OptionalMailService;
    appUrl: string | null;
    logger: Logger;
  },
  mail: ScheduleMail | null,
): Promise<void> {
  if (!mail) return;
  const { prisma, logger } = deps;
  const at = `recipient=${mail.notificationRecipientId}`;
  if (!deps.mail || !deps.appUrl) {
    logger.warn(
      `work schedule mail SKIPPED ${at}: ${deps.mail ? 'no STAFF_APP_URL' : 'no MAIL_*'}`,
    );
    return;
  }
  let result: 'SUCCEEDED' | 'FAILED';
  try {
    await deps.mail.send({
      templateCode: MAIL_TEMPLATE_CODE,
      to: mail.to,
      variables: {
        ...mail.variables,
        링크: new URL(STAFF_APP_WORK_PATH, deps.appUrl).toString(),
      },
    });
    result = 'SUCCEEDED';
  } catch (e) {
    if (!isMailTransportError(e)) {
      logger.error(
        `work schedule mail NOT SENT(before SMTP) ${at} ${errorKind(e)}`,
      );
      return;
    }
    // 본문을 보낸 뒤 끊긴 시간 초과면 Gmail 이 받았을 수도 있다(MailService 주석) — FAILED 를 근거로 자동 재발송하지 않는다
    logger.warn(`work schedule mail FAILED(SMTP) ${at} ${errorKind(e)}`);
    result = 'FAILED';
  }
  try {
    await prisma.notificationDelivery.create({
      data: {
        notificationRecipientId: mail.notificationRecipientId,
        channel: 'EMAIL',
        result,
        sentAt: result === 'SUCCEEDED' ? new Date() : null,
      },
    });
  } catch (e) {
    logger.error(
      `work schedule mail delivery row not written ${at} result=${result} ${errorKind(e)}`,
    );
  }
}
