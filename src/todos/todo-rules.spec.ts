import { TodoStatus } from '@prisma/client';
import {
  compareTodos,
  dueKey,
  dueLabel,
  dueReminderAt,
  groupStatus,
} from './todo-rules';

const d = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
const t = (hm: string) => new Date(`1970-01-01T${hm}:00.000Z`);
const row = (
  todoId: number,
  status: TodoStatus,
  isUrgent: boolean,
  dueDate: string,
  dueTime: string | null = null,
) => ({
  todoId,
  status,
  isUrgent,
  dueDate: d(dueDate),
  dueTime: dueTime ? t(dueTime) : null,
});

describe('compareTodos (목록 정렬)', () => {
  it('미완료 긴급 → 미완료 나머지 → 완료, 묶음 안은 수행 예정 일시 오름차순, 마지막은 ID', () => {
    const rows = [
      row(1, 'DONE', true, '2026-10-01'),
      row(2, 'PENDING', false, '2026-10-20'),
      row(3, 'IN_PROGRESS', true, '2026-10-25'),
      row(4, 'PENDING', true, '2026-10-21', '09:00'),
      row(5, 'PENDING', false, '2026-10-20', '08:00'),
      row(6, 'DONE', false, '2026-09-30'),
      row(7, 'PENDING', false, '2026-10-20'),
    ];
    expect(rows.sort(compareTodos).map((r) => r.todoId)).toEqual([
      4, 3, 5, 2, 7, 6, 1,
    ]);
  });
});

describe('groupStatus (묶음 상태)', () => {
  it('모두 완료면 완료, 모두 대기면 대기, 섞이면 진행 중', () => {
    expect(groupStatus(['DONE', 'DONE'])).toBe('DONE');
    expect(groupStatus(['PENDING', 'PENDING'])).toBe('PENDING');
    expect(groupStatus(['PENDING', 'DONE'])).toBe('IN_PROGRESS');
    expect(groupStatus(['IN_PROGRESS'])).toBe('IN_PROGRESS');
  });
});

describe('수행 예정 일시', () => {
  it('시간이 있으면 한국 시각 1시간 전, 날짜만이면 그날 한국 09:00 에 알린다', () => {
    // 한국 18:00 = UTC 09:00 → 1시간 전 UTC 08:00
    expect(dueReminderAt(d('2026-10-19'), t('18:00')).toISOString()).toBe(
      '2026-10-19T08:00:00.000Z',
    );
    // 한국 00:30 의 1시간 전은 전날 한국 23:30
    expect(dueReminderAt(d('2026-10-20'), t('00:30')).toISOString()).toBe(
      '2026-10-19T14:30:00.000Z',
    );
    expect(dueReminderAt(d('2026-10-19'), null).toISOString()).toBe(
      '2026-10-19T00:00:00.000Z',
    );
  });

  it('dedupe 에 넣는 키와 알림 문구의 표시', () => {
    expect(dueKey(d('2026-10-19'), t('18:00'))).toBe('2026-10-19T18:00');
    expect(dueKey(d('2026-10-19'), null)).toBe('2026-10-19');
    expect(dueLabel(d('2026-10-08'), t('18:00'))).toBe('10월 8일 18:00');
    expect(dueLabel(d('2026-10-08'), null)).toBe('10월 8일');
  });
});
