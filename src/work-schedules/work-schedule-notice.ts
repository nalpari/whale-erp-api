import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  renderTemplate,
  type TemplateSource,
  type TemplateVariable,
} from '../notification-templates/render-template';
import { reasonOf } from '../notifications/ops-notification.service';
import { kstTimeOf, type Span, workDateOf } from './work-schedule-rules';

const TEMPLATE_CODE = 'PUSH_SCHEDULE_CHANGED';
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

/**
 * 근무스케줄 저장 알림(#201, STAFF-15). 저장 한 번에 바뀐 직원에게 직원 알림 하나와 앱 푸시 발송 대기 하나를 만든다 —
 * 저장 트랜잭션 안에서 부른다(저장이 되돌려지면 알림도 없다). 시간과 관계없이 곧바로다. 템플릿의 수신 설정 묶음(기본 「근무스케줄」)을
 * 끈 직원은 앱 푸시 없이 알림함에만 남는다(NTF-14). 퇴직 처리가 지울 때는 부르지 않는다(PAY-14).
 *
 * 템플릿을 쓸 수 없으면(없음 · 채널이 다름 · 사용 안 함 · 렌더 실패) 알림 없이 저장만 한다 — 운영자가 템플릿을 잘못
 * 고쳐도 관리자의 저장이 막히면 안 된다. 사용 안 함만 warn 이고 나머지는 고쳐야 할 일이라 error 다. DB 오류는 던진다.
 * 수행 임박 알림(src/todos/todo-due-soon.service.ts)과 같은 순서다.
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
): Promise<void> {
  // 시작 · 종료 · 휴게가 모두 같은 수정은 바뀐 것이 없다 — 알리지 않는다(변경 이력은 저장 쪽이 남긴다, api #106 리뷰)
  const changes = input.changes.filter((c) => !isUnchanged(c));
  if (changes.length === 0) return;
  const staff = await tx.staffMember.findUnique({
    where: { staffMemberId: input.staffMemberId },
    select: {
      storeId: true,
      employmentStatus: true,
      account: { select: { accountId: true, status: true } },
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
    return;
  }
  const account = staff?.account;
  if (!account || account.status === 'WITHDRAWN') {
    logger.warn(
      `work schedule notice SKIPPED staffMember ${input.staffMemberId}: ${account ? 'withdrawn account' : 'no account'}`,
    );
    return;
  }
  // 점포는 1팀 표라 직원 레코드에서 관계로 닿지 않는다. 이름이 없으면 제목이 「 근무스케줄이…」로 나가니 보내지 않는다
  const store = await tx.store.findUnique({
    where: { storeId: staff.storeId },
    select: { name: true },
  });
  if (!store?.name) {
    logger.error(
      `work schedule notice SKIPPED staffMember ${input.staffMemberId}: store ${staff.storeId} ${store ? 'has no name' : 'missing'}`,
    );
    return;
  }

  const row = await tx.notificationTemplate.findUnique({
    where: { templateCode: TEMPLATE_CODE },
  });
  if (!row || row.channel !== 'PUSH') {
    logger.error(
      `work schedule notice SKIPPED template ${TEMPLATE_CODE}: ${row ? `channel ${row.channel}` : 'missing'}`,
    );
    return;
  }
  if (!row.isActive) {
    logger.warn(
      `work schedule notice SKIPPED template ${TEMPLATE_CODE}: inactive`,
    );
    return;
  }
  const template: TemplateSource = {
    templateCode: TEMPLATE_CODE,
    title: row.title,
    body: row.body,
    // CHECK notification_templates_variables_array 가 배열임을 보장한다.
    variables: row.variables as TemplateVariable[],
  };
  let rendered: { subject: string | null; body: string };
  try {
    rendered = renderTemplate(template, {
      근무지: store.name,
      // 여러 건은 시작 시각순으로 잇는다(삭제는 변경 전 시각)
      변경내용: [...changes]
        .sort((a, b) => startOf(a).getTime() - startOf(b).getTime())
        .map(changeText)
        .join(', '),
    });
    if (rendered.subject === null) throw new Error('제목이 없습니다');
  } catch (e) {
    logger.error(
      `work schedule notice SKIPPED template ${TEMPLATE_CODE}: cannot render — ${reasonOf(e)}`,
    );
    return;
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
  if (!off)
    await tx.notificationDelivery.create({
      data: {
        notificationRecipientId: recipient.notificationRecipientId,
        channel: 'PUSH',
      },
    });
  // TODO(#321): 앱 푸시 발송 자리 — 수행 임박 알림과 같이 발송 대기 행만 남긴다
}
