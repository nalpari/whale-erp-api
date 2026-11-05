import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { BATCH_JOB } from '../batch/batch-job-names';
import { BatchLockService } from '../batch/batch-lock.service';
import { addDays, addMonths, kstToday } from './kst-date';

/** 보존 기간 — 퇴직일로부터 3년(운영 정책 RET-01 · RET-04 · TAX-08, 2026-11-03 노무사 · 법무 검토 확정) */
const RETENTION_MONTHS = 36;

/** 한 번에 지우는 최대 건수 — 근무스케줄 파기와 같은 까닭(runExclusive 60초 제한, api #112 리뷰) */
export const PURGE_BATCH_SIZE = 5000;

/**
 * 퇴직일이 이 날짜 앞이면 보존 기간이 끝났다(WHALEERP-645). 퇴직일 + 3년 당일까지 남고 그다음 날 지워진다 — 한국 날짜로
 * 센다(근무스케줄 파기와 같은 꼴). 퇴직일(@db.Date)과 견주는 날짜라 SQL 에서는 `::date` 로 바꿔 쓴다.
 * 윤년 2월 29일에는 3년 전 같은 날이 없어 addMonths 가 2월 28일로 당긴다 — 그러면 2월 28일 퇴직(+ 3년 = 어제)이 하루 늦게
 * 지워지므로 그다음 날(3월 1일)을 기준으로 한다(WHALEERP-652, api #238 리뷰). 다른 날은 그대로다.
 */
export function retiredBefore(now: Date = new Date()): Date {
  const today = kstToday(now);
  const before = addMonths(today, -RETENTION_MONTHS);
  return before.getUTCDate() === today.getUTCDate()
    ? before
    : addDays(before, 1);
}

/**
 * 퇴직일로부터 3년이 지난 직원 레코드의 신고 정보와 신고 정보 이력을 지운다(TAX-08, WHALEERP-645). 퇴직 확정이 된
 * 레코드(RETIRED)만 본다 — 퇴직일만 잡힌 퇴직 예정(EMPLOYED)은 남는다. 계정이 탈퇴해도 같은 기준이다(RET-07).
 * 직원 레코드를 퇴직 취소 · 신고 정보 저장과 같은 잠금(FOR NO KEY UPDATE)으로, id 순으로 잡고 지운다 — 그사이 퇴직이 취소되면
 * 기다렸다가 새 스냅샷에서 빠진다. 신고 정보를 지운 직원 레코드 수를 돌려준다(배치 로그).
 */
export async function purgeRetiredTaxProfiles(
  tx: Prisma.TransactionClient,
  now: Date = new Date(),
): Promise<number> {
  const before = retiredBefore(now);
  // 퇴직일이 이른 순으로 고르되 직원 행은 id 순으로 잠근다 — 계약 등록(lockStaffForReplace) · 하루 배치와 같은 순서라 교착하지
  // 않는다(api #238 리뷰). 잠근 뒤 바깥 조건(퇴직 · 기준 날짜)을 다시 본다.
  const targets = await tx.$queryRaw<{ id: number }[]>`
    SELECT s.staff_member_id AS id FROM staff_members s
    WHERE s.staff_member_id IN (
        SELECT t.staff_member_id FROM staff_members t
        WHERE t.employment_status = 'RETIRED' AND t.retired_date < ${before}::date
          AND (EXISTS (SELECT 1 FROM staff_tax_profiles p WHERE p.staff_member_id = t.staff_member_id)
            OR EXISTS (SELECT 1 FROM staff_tax_profile_histories h WHERE h.staff_member_id = t.staff_member_id))
        ORDER BY t.retired_date, t.staff_member_id
        LIMIT ${PURGE_BATCH_SIZE})
      AND s.employment_status = 'RETIRED' AND s.retired_date < ${before}::date
    ORDER BY s.staff_member_id
    FOR NO KEY UPDATE OF s
  `;
  if (targets.length === 0) return 0;
  const where = { staffMemberId: { in: targets.map((t) => t.id) } };
  await tx.staffTaxProfileHistory.deleteMany({ where });
  await tx.staffTaxProfile.deleteMany({ where });
  return targets.length;
}

/** 계약 · 급여와 같은 보존 기간으로 지우는 변경 이력 항목(RET-04). 이메일 · 비밀번호 · 생년월일 이력은 남는다. */
const PURGED_FIELDS = ['PHONE', 'ADDRESS'] as const;

/**
 * 계정의 휴대전화번호 · 주소 변경 이력을 계약 · 급여와 같은 보존 기간으로 지운다(RET-04, WHALEERP-645). 기준 날짜는
 * 그 계정에 연결된 직원 레코드(staff_members.account_id)의 가장 늦은 퇴직일이다(2026-11-03 김민식 확정) — 레코드가 하나 이상
 * 있고 모두 퇴직 확정(RETIRED)이며 퇴직일 + 3년이 지났을 때만 지운다. 재직 중이거나 퇴직 예정인 소속이 하나라도 있거나,
 * 연결된 레코드가 없는 계정은 남는다. 탈퇴한 계정도 같은 기준이다(RET-07). 계정 행을 FOR UPDATE 로 잡는다 — 이력을 넣는
 * 쪽(외래키 확인)이 기다렸다가 그 뒤에 넣는다. 지운 이력 건수를 돌려준다(배치 로그).
 */
export async function purgeRetiredAccountChanges(
  tx: Prisma.TransactionClient,
  now: Date = new Date(),
): Promise<number> {
  const before = retiredBefore(now);
  const targets = await tx.$queryRaw<{ id: number }[]>`
    SELECT a.account_id AS id FROM accounts a
    WHERE EXISTS (SELECT 1 FROM account_change_histories h
        WHERE h.account_id = a.account_id AND h.field::text IN (${Prisma.join(PURGED_FIELDS)}))
      AND EXISTS (SELECT 1 FROM staff_members s WHERE s.account_id = a.account_id)
      AND NOT EXISTS (SELECT 1 FROM staff_members s WHERE s.account_id = a.account_id
        AND (s.employment_status <> 'RETIRED' OR s.retired_date IS NULL OR s.retired_date >= ${before}::date))
    ORDER BY a.account_id
    LIMIT ${PURGE_BATCH_SIZE}
    FOR UPDATE OF a
  `;
  if (targets.length === 0) return 0;
  // 소속 조건을 다시 본다 — 계정 행은 그대로라 잠금을 기다려도 위 판정은 처음 스냅샷이다. 그사이 커밋된 가입(새 재직 소속)은
  // 잠근 뒤의 이 문장이 보고 빼낸다(requesting-code-review)
  const { count } = await tx.accountChangeHistory.deleteMany({
    where: {
      accountId: { in: targets.map((t) => t.id) },
      field: { in: [...PURGED_FIELDS] },
      account: {
        staffMembers: {
          none: {
            OR: [
              { employmentStatus: { not: 'RETIRED' } },
              { retiredDate: null },
              { retiredDate: { gte: before } },
            ],
          },
        },
      },
    },
  });
  return count;
}

@Injectable()
export class RetireePurgeScheduler {
  constructor(private readonly lock: BatchLockService) {}

  // 05:00 퇴직자 근로계약 파기 뒤에 돈다. 건수는 runExclusive 가 `tax-profile-purge RAN processed=N` 으로 남긴다.
  @Cron('0 10 5 * * *', {
    name: BATCH_JOB.TAX_PROFILE_PURGE,
    timeZone: 'Asia/Seoul',
  })
  async purgeTaxProfiles(): Promise<void> {
    await this.lock.runExclusive(BATCH_JOB.TAX_PROFILE_PURGE, (tx) =>
      purgeRetiredTaxProfiles(tx),
    );
  }

  @Cron('0 20 5 * * *', {
    name: BATCH_JOB.ACCOUNT_CHANGE_PURGE,
    timeZone: 'Asia/Seoul',
  })
  async purgeAccountChanges(): Promise<void> {
    await this.lock.runExclusive(BATCH_JOB.ACCOUNT_CHANGE_PURGE, (tx) =>
      purgeRetiredAccountChanges(tx),
    );
  }
}
