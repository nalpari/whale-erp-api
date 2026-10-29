import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PayslipItemCategory, PayslipStatus, Prisma } from '@prisma/client';
import {
  AdminScopeService,
  hidesPersonalData,
} from '../admin-scope/admin-scope.service';
import {
  HQ_SHARING_SELECT,
  hqSharingConsentedOf,
} from '../admin-scope/hq-sharing';
import { sameMillisecond } from '../common/updated-at';
import { PrismaService } from '../prisma/prisma.service';
import { kstToday } from '../staff-members/kst-date';
import { PayslipStatusChangeDto, SavePayslipDto } from './dto/payslip-edit.dto';
import {
  PayslipAdditionalItemsResponseDto,
  PayslipPreviousResponseDto,
} from './dto/payslip-edit.response.dto';
import { PayslipDetailResponseDto } from './dto/payslip.response.dto';
import { PayslipListService } from './payslip-list.service';
import {
  ATTENDANCE_REVIEW_REASONS,
  attendanceReviewReasons,
  confirmableFrom,
  periodContractIds,
  contractsEmploymentMixed,
  reviewReasonsOf,
} from './payslip-attendance-reasons';
import {
  amountsOf,
  CALCULATED_ITEM_CODES,
  calculatePayslip,
  CalculatedItemCode,
} from './payslip-calculation';
import { PAYSLIP_NOT_FOUND_MESSAGE } from './payslip-menu';
import { amountOf, dateOnly, isShown, ITEM_ORDER } from './payslip-shared';

type Tx = Prisma.TransactionClient;

const MAX_INT = 2_147_483_647;
const EDITABLE: readonly PayslipStatus[] = ['DRAFTING', 'REVIEWING'];
const CONFIRMED: readonly PayslipStatus[] = ['CONFIRMED', 'SENT'];

const NOW_STATUS: Record<PayslipStatus, string> = {
  DRAFTING: '작성 중인 급여명세서입니다',
  REVIEWING: '검토 중인 급여명세서입니다',
  CONFIRMED: '이미 확정한 급여명세서입니다',
  SENT: '이미 발송한 급여명세서입니다',
};

/** 409 PAYSLIP_STATUS_CONFLICT — 지금 상태로는 그 일을 할 수 없다. 본문에 지금 상태를 싣는다(근로계약 상태 전환과 같은 모양). */
export const statusConflict = (now: PayslipStatus) =>
  new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: 'PAYSLIP_STATUS_CONFLICT',
    message: `${NOW_STATUS[now]}. 화면을 새로 고쳐 지금 상태를 확인해 주세요.`,
    status: now,
  });

/** 409 PAYSLIP_STALE — 읽은 뒤 그사이 누가 고쳤다(updatedAt 이 다르다). */
export const stale = () =>
  new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: 'PAYSLIP_STALE',
    message:
      '그사이 다른 관리자가 이 급여명세서를 고쳤습니다. 화면을 새로 고친 뒤 다시 해 주세요.',
  });

const LINE_SELECT = {
  payslipItemId: true,
  itemCategory: true,
  payslipItemMasterId: true,
  itemName: true,
  calculatedAmount: true,
  adjustedAmount: true,
  isEntered: true,
  payslipItemMaster: {
    select: {
      payslipItemMasterId: true,
      itemCode: true,
      isSystemCalculated: true,
    },
  },
} satisfies Prisma.PayslipItemSelect;

interface Line {
  payslipItemId: number;
  payslipItemMasterId: number;
  itemCategory: PayslipItemCategory;
  itemName: string;
  calculatedAmount: number | null;
  adjustedAmount: number | null;
  isEntered: boolean;
  payslipItemMaster: { itemCode: string; isSystemCalculated: boolean };
}

/** 지급 총액 · 공제 총액 · 실지급액. 숨은 줄은 세지 않고 미입력은 0 으로 센다(확정은 미입력 공제를 따로 막는다). */
function totalsOf(lines: Line[], withholding: boolean) {
  let gross = 0;
  let deduction = 0;
  for (const l of lines) {
    if (!isShown(l, withholding)) continue;
    const amount = amountOf(l) ?? 0;
    if (l.itemCategory === 'EARNING') gross += amount;
    else deduction += amount;
  }
  if (gross > MAX_INT || deduction > MAX_INT || gross - deduction < -MAX_INT)
    throw new BadRequestException('금액 합계가 너무 큽니다.');
  return {
    grossPayAmount: gross,
    totalDeductionAmount: deduction,
    netPayAmount: gross - deduction,
  };
}

/** 「출퇴근으로 다시 계산」이 지금 데이터로 모두 새로 판정하는 검토 대기 사유. 공제 미입력은 저장하지 않고 확정이 막는다(목록의 검토 대기는 공제 칸으로 판정한다) */
const RECALCULATED_REASONS = [
  ...ATTENDANCE_REVIEW_REASONS,
  'CONTRACT_CHANGED',
] as const;

/** 처리 이력에 쓰는 검토 대기 사유 이름(db enum 이름과 같다) */
const REASON_LABEL: Record<string, string> = {
  MISSING_ATTENDANCE: '출퇴근 누락',
  CONTRACT_CHANGED: '기간 중 계약 변경',
  AFTER_CONTRACT_END: '계약 만료 후 기록',
  ATTENDANCE_NEEDS_REVIEW: '확인 필요 기록 포함',
};

/** 시스템 계산 줄이면 그 항목 코드 */
const calculatedCodeOf = (l: Line): CalculatedItemCode | null =>
  (CALCULATED_ITEM_CODES as readonly string[]).includes(
    l.payslipItemMaster.itemCode,
  )
    ? (l.payslipItemMaster.itemCode as CalculatedItemCode)
    : null;

const won = (amount: number | null) =>
  amount === null ? '미입력' : `${amount.toLocaleString('ko-KR')}원`;

/**
 * 급여명세서 임시저장 · 확정 · 확정 취소 · 지난 명세서 불러오기 · 추가 공제 항목 (WHALEERP-228 · 230). 공제는 요율이 해마다
 * 바뀌어 시스템이 계산하지 않고 관리자가 넣는다 — 3.3% 원천징수도 관리자가 넣는다(비과세를 포함한 지급 총액에 매긴다는
 * 기준은 화면이 알린다). 관리 범위 · 가림은 상세와 같다(없음 · 범위 밖 · 가림은 모두 같은 404).
 *
 * 저장은 상태를 바꾸지 않는다 — 작성 중은 작성 중, 검토 중은 검토 중이다. 동시 저장은 상세의 `updatedAt` 을 조건으로 건
 * UPDATE 로 막는다(게시물 · 문의와 같은 방식) — 그 UPDATE 가 명세서 행을 잠가, 같은 트랜잭션의 나머지 쓰기는 줄을 선다.
 */
@Injectable()
export class PayslipEditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: AdminScopeService,
    private readonly detail: PayslipListService,
  ) {}

  /** 「항목 추가」로 붙일 수 있는 추가 공제. */
  async additionalItems(): Promise<PayslipAdditionalItemsResponseDto> {
    const items = await this.prisma.payslipItemMaster.findMany({
      where: { isActive: true, category: 'ADDITIONAL' },
      orderBy: [{ sortOrder: 'asc' }, { payslipItemMasterId: 'asc' }],
      select: { payslipItemMasterId: true, itemCode: true, name: true },
    });
    return { items };
  }

  /** 같은 직원(레코드)의 지난 명세서 — 급여 기간이 앞선 것 중 가장 늦은 것의 공제와 관리자가 넣는 지급 값. */
  async previousValues(
    adminAccountId: number,
    payslipId: number,
  ): Promise<PayslipPreviousResponseDto> {
    const current = await this.locate(adminAccountId, payslipId);
    const previous = await this.prisma.payslip.findFirst({
      where: {
        staffMemberId: current.staffMemberId,
        periodStartDate: { lt: current.periodStartDate },
      },
      orderBy: [{ periodStartDate: 'desc' }, { payslipId: 'desc' }],
      select: {
        payslipId: true,
        periodStartDate: true,
        periodEndDate: true,
        payslipItems: { orderBy: ITEM_ORDER, select: LINE_SELECT },
      },
    });
    if (!previous) return { previous: null };
    return {
      previous: {
        payslipId: previous.payslipId,
        periodStartDate: dateOnly(previous.periodStartDate),
        periodEndDate: dateOnly(previous.periodEndDate),
        items: previous.payslipItems
          .filter(
            (l) =>
              l.isEntered &&
              !(
                l.itemCategory === 'EARNING' &&
                l.payslipItemMaster.isSystemCalculated
              ),
          )
          .map((l) => ({
            payslipItemMasterId: l.payslipItemMasterId,
            itemCode: l.payslipItemMaster.itemCode,
            itemName: l.itemName,
            itemCategory: l.itemCategory,
            amount: amountOf(l) ?? 0,
          })),
      },
    };
  }

  /**
   * 임시저장. 작성 중 · 검토 중만(아니면 409). 지급 · 기본 공제 · 원천징수 줄은 실은 것만 고치고, 추가 공제는 실은 것이 곧
   * 붙은 목록이다. 시스템 계산 항목(기본급 · 주휴 · 연장)은 고친 값을 adjustedAmount 에 두고, 계산값과 같거나 null 이면
   * 계산값으로 돌린다. 합계를 다시 셈하고, 바꾼 것이 있으면 처리 이력(수정)에 한 줄 남긴다.
   *
   * 가산 적용을 바꾸면 연장수당만 그 값으로 다시 계산한다(PAY-05, WHALEERP-227, 목업 payrolls-detail) — 끄면 가산 없이 1배로
   * 계산한다(2026-10-26 재영). 화면이 보낸 값이 바꾸기 전 계산값과 같으면(고친 값이 없던 줄) 관리자가 고치지 않은 것으로 보고
   * 새 계산값을 따르고, 다르면 고친 값으로 남긴다. 앞서 고쳐 둔 값(adjustedAmount)은 그대로 돌려보내도 지키고 계산값 칸만 새로 둔다
   * (PR #159 리뷰).
   */
  async save(
    adminAccountId: number,
    payslipId: number,
    dto: SavePayslipDto,
  ): Promise<PayslipDetailResponseDto | null> {
    const current = await this.locate(adminAccountId, payslipId);
    if (!EDITABLE.includes(current.status))
      throw statusConflict(current.status);
    if (dto.isWithholdingApplied && current.employmentType !== 'PART_TIME')
      throw new BadRequestException(
        '3.3% 원천징수는 파트타이머 명세서에만 적용할 수 있습니다.',
      );
    const wanted = new Map<number, number | null>();
    for (const { payslipItemMasterId, amount } of dto.items) {
      if (wanted.has(payslipItemMasterId))
        throw new BadRequestException('같은 항목을 두 번 보냈습니다.');
      wanted.set(payslipItemMasterId, amount);
    }

    await this.prisma.$transaction(async (tx) => {
      await this.claim(tx, payslipId, current.status, dto.updatedAt, {
        isPremiumApplied: dto.isPremiumApplied,
        isWithholdingApplied: dto.isWithholdingApplied,
      });
      const lines = await this.lines(tx, payslipId);
      const changes: string[] = [];
      const fresh =
        dto.isPremiumApplied !== current.isPremiumApplied
          ? amountsOf(
              await calculatePayslip(tx, {
                ...current,
                contractIds: await this.contractIdsOf(tx, current),
                isPremiumApplied: dto.isPremiumApplied,
              }),
            )
          : null;
      if (dto.isPremiumApplied !== current.isPremiumApplied)
        changes.push(`가산 적용 ${dto.isPremiumApplied ? '켬' : '해제'}`);
      if (dto.isWithholdingApplied !== current.isWithholdingApplied)
        changes.push(
          `3.3% 원천징수 ${dto.isWithholdingApplied ? '적용' : '해제'}`,
        );

      const kept: Line[] = [];
      const removed: Line[] = [];
      for (const l of lines) {
        const masterId = l.payslipItemMasterId;
        const code = calculatedCodeOf(l);
        // 가산이 바꾸는 것은 연장수당뿐이다 — 기본급 · 주휴수당은 그대로 둔다(고친 값도, 그사이 바뀐 출퇴근도 「다시 계산」의 일)
        const recalculated = fresh && code === 'OVERTIME_PAY';
        if (!wanted.has(masterId) && !recalculated) {
          (l.itemCategory === 'ADDITIONAL' ? removed : kept).push(l);
          continue;
        }
        let amount = wanted.has(masterId)
          ? wanted.get(masterId)!
          : l.adjustedAmount;
        wanted.delete(masterId);
        let base = l;
        if (recalculated) {
          // 바꾸기 전과 같은 계산값은 고치지 않은 것 — 새 계산값을 따른다. 관리자가 고친 값(adjustedAmount)은 가산을 바꿔도 지키고 새
          // 계산값은 계산값 칸에만 둔다 — 덮으면 넣은 연장수당이 알림 없이 바뀌거나(새 계산값이 null 이면) 미입력이 된다(PR #159 리뷰)
          if (amount === amountOf(l) && l.adjustedAmount === null)
            amount = null;
          base = { ...l, calculatedAmount: fresh[code] };
        }
        const next = {
          ...(recalculated && { calculatedAmount: base.calculatedAmount }),
          ...this.nextValue(base, amount),
        };
        if (
          base.calculatedAmount !== l.calculatedAmount ||
          next.adjustedAmount !== l.adjustedAmount ||
          next.isEntered !== l.isEntered
        ) {
          await tx.payslipItem.update({
            where: { payslipItemId: l.payslipItemId },
            data: next,
          });
          const after = { ...l, ...next };
          if (amountOf(l) !== amountOf(after))
            changes.push(
              `${l.itemName} ${won(amountOf(l))} → ${won(amountOf(after))}`,
            );
          kept.push(after);
        } else kept.push(l);
      }

      // 남은 것은 새로 붙일 추가 공제여야 한다
      if (wanted.size > 0) {
        const masters = await tx.payslipItemMaster.findMany({
          where: {
            payslipItemMasterId: { in: [...wanted.keys()] },
            isActive: true,
            category: 'ADDITIONAL',
          },
          select: {
            payslipItemMasterId: true,
            itemCode: true,
            isSystemCalculated: true,
            name: true,
            category: true,
            isTaxFree: true,
          },
        });
        if (masters.length !== wanted.size)
          throw new BadRequestException(
            '붙일 수 없는 급여 항목이 있습니다. 화면을 새로 고친 뒤 다시 해 주세요.',
          );
        for (const m of masters) {
          const amount = wanted.get(m.payslipItemMasterId)!;
          const data = {
            payslipId,
            payslipItemMasterId: m.payslipItemMasterId,
            itemCategory: m.category,
            itemName: m.name,
            isTaxFree: m.isTaxFree,
            calculatedAmount: null,
            adjustedAmount: amount,
            isEntered: amount !== null,
          };
          await tx.payslipItem.create({ data });
          changes.push(`항목 추가 ${m.name}`);
          kept.push({ ...data, payslipItemId: 0, payslipItemMaster: m });
        }
      }
      if (removed.length > 0) {
        await tx.payslipItem.deleteMany({
          where: { payslipItemId: { in: removed.map((l) => l.payslipItemId) } },
        });
        for (const l of removed) changes.push(`항목 삭제 ${l.itemName}`);
      }

      await tx.payslip.update({
        where: { payslipId },
        data: totalsOf(kept, dto.isWithholdingApplied),
      });
      if (changes.length > 0)
        await tx.payslipLog.create({
          data: {
            payslipId,
            logType: 'EDIT',
            fromStatus: null,
            toStatus: null,
            summary: changes.join(' · '),
            changedBy: adminAccountId,
          },
        });
    });
    return this.detail.findOne(adminAccountId, payslipId);
  }

  /**
   * 출퇴근으로 다시 계산(WHALEERP-227, 데모 「출퇴근으로 다시 계산」). 작성 중 · 검토 중만(아니면 409). 기본급 · 주휴수당 ·
   * 연장수당을 지금 출퇴근 기록과 명세서의 가산 값으로 다시 계산하고, 관리자가 고친 값은 버린다(계산값으로 돌린다). 합계를 다시
   * 셈하고 바뀐 것을 처리 이력(수정)에 남긴다 — 바뀐 것이 없어도 「출퇴근으로 다시 계산」 한 줄은 남는다.
   * 검토 대기 사유(출퇴근 누락 · 기간 중 계약 변경 · 계약 만료 후 기록 · 확인 필요 기록 포함, WHALEERP-229)도 지금 데이터로 모두
   * 새로 판정한다 — 앞서 「확인」한 표시는 지우고 다시 붙인다(2026-10-26 재영). 보정한 뒤 다시
   * 계산하면 경고가 풀린다.
   */
  async recalculate(
    adminAccountId: number,
    payslipId: number,
    dto: PayslipStatusChangeDto,
  ): Promise<PayslipDetailResponseDto | null> {
    const current = await this.locate(adminAccountId, payslipId);
    if (!EDITABLE.includes(current.status))
      throw statusConflict(current.status);
    await this.prisma.$transaction(async (tx) => {
      await this.claim(tx, payslipId, current.status, dto.updatedAt, {
        updatedAt: new Date(),
      });
      const contractIds = await this.contractIdsOf(tx, current);
      const fresh = amountsOf(
        await calculatePayslip(tx, { ...current, contractIds }),
      );
      const changes: string[] = [];
      const lines: Line[] = [];
      for (const l of await this.lines(tx, payslipId)) {
        const code = calculatedCodeOf(l);
        if (code === null) {
          lines.push(l);
          continue;
        }
        const next = {
          calculatedAmount: fresh[code],
          adjustedAmount: null,
          isEntered: fresh[code] !== null,
        };
        const after = { ...l, ...next };
        if (
          next.calculatedAmount !== l.calculatedAmount ||
          l.adjustedAmount !== null ||
          next.isEntered !== l.isEntered
        )
          await tx.payslipItem.update({
            where: { payslipItemId: l.payslipItemId },
            data: next,
          });
        if (amountOf(l) !== amountOf(after))
          changes.push(
            `${l.itemName} ${won(amountOf(l))} → ${won(amountOf(after))}`,
          );
        lines.push(after);
      }
      await tx.payslip.update({
        where: { payslipId },
        data: totalsOf(lines, current.isWithholdingApplied),
      });
      changes.push(
        ...(await this.refreshReviewReasons(
          tx,
          payslipId,
          current,
          contractIds,
        )),
      );
      await tx.payslipLog.create({
        data: {
          payslipId,
          logType: 'EDIT',
          fromStatus: null,
          toStatus: null,
          summary: ['출퇴근으로 다시 계산', ...changes].join(' · '),
          changedBy: adminAccountId,
        },
      });
    });
    return this.detail.findOne(adminAccountId, payslipId);
  }

  /**
   * 확정. 작성 중 · 검토 중만(아니면 409). 보이는 공제(기본 공제 · 붙인 추가 공제, 3.3% 를 켜면 소득세 · 지방소득세 대신
   * 원천징수)가 하나라도 미입력이면 422 DEDUCTION_MISSING 과 그 항목. 검토 사유가 있어도 확정하는 것이 「확인」이다 —
   * 확인하지 않은 사유에 확정 시각을 확인 일시로 남긴다. 확정할 수 있는 날(`confirmableFrom` — 퇴직일 · 마지막 계약 종료일 · 급여
   * 기간 마지막 날 가운데 가장 빠른 날의 다음 날, 한국. 그 계약의 진행 중 갱신이 기간 안에 시작하면 계약 종료일은 보지 않는다) 전이면 422 PERIOD_NOT_ENDED — 남은 날의 근무가 빠진 명세서가 발송되지
   * 않게 막는다. 초안은 그 전에도 미리 보기로 만든다(운영 정책 PAY-06 v247 · v251).
   */
  async confirm(
    adminAccountId: number,
    payslipId: number,
    dto: PayslipStatusChangeDto,
  ): Promise<PayslipDetailResponseDto | null> {
    const current = await this.locate(adminAccountId, payslipId);
    if (!EDITABLE.includes(current.status))
      throw statusConflict(current.status);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await this.claim(tx, payslipId, current.status, dto.updatedAt, {
        status: 'CONFIRMED',
        confirmedAt: now,
        confirmedBy: adminAccountId,
      });
      // 확정할 수 있는 날은 트랜잭션 안에서 본다 — 밖에서 본 뒤 그사이 퇴직일을 지우면 기간 중에 확정되지 않게(막히면 되돌린다)
      const from = await confirmableFrom(tx, {
        ...current,
        contractIds: await this.contractIdsOf(tx, current),
      });
      if (dateOnly(kstToday(now)) < from)
        throw new UnprocessableEntityException({
          statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
          error: 'Unprocessable Entity',
          code: 'PERIOD_NOT_ENDED',
          message: `아직 확정할 수 없습니다. ${from} 부터 확정할 수 있습니다 — 급여 기간 마지막 날(그 전에 퇴직하거나 계약이 끝나면 그날. 진행 중인 갱신 계약이 있으면 급여 기간 마지막 날)이 지나야 합니다.`,
        });
      const missing = (await this.lines(tx, payslipId)).filter(
        (l) =>
          l.itemCategory !== 'EARNING' &&
          isShown(l, current.isWithholdingApplied) &&
          !l.isEntered,
      );
      if (missing.length > 0)
        throw new UnprocessableEntityException({
          statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
          error: 'Unprocessable Entity',
          code: 'DEDUCTION_MISSING',
          message: `비어 있는 공제가 있어 확정할 수 없습니다: ${missing.map((l) => l.itemName).join(', ')}. 공제 대상이 아니면 0 을 넣어 주세요.`,
          items: missing.map((l) => ({
            payslipItemId: l.payslipItemId,
            itemName: l.itemName,
          })),
        });
      const { count } = await tx.payslipReviewReason.updateMany({
        where: { payslipId, acknowledgedAt: null },
        data: { acknowledgedAt: now },
      });
      await tx.payslipLog.create({
        data: {
          payslipId,
          logType: 'CONFIRM',
          fromStatus: current.status,
          toStatus: 'CONFIRMED',
          summary: count > 0 ? `확정 · 검토 사유 ${count}건 확인` : '확정',
          changedBy: adminAccountId,
        },
      });
    });
    return this.detail.findOne(adminAccountId, payslipId);
  }

  /**
   * 확정 취소. 확정 · 발송 완료(보낸 뒤에도)에서 검토 중으로 돌린다. 확정 일시 · 관리자를 비우고, 확정이 확인한 검토 사유를
   * 다시 확인 전으로 돌린다(운영 정책 v221 PAY-06).
   */
  async cancelConfirmation(
    adminAccountId: number,
    payslipId: number,
    dto: PayslipStatusChangeDto,
  ): Promise<PayslipDetailResponseDto | null> {
    const current = await this.locate(adminAccountId, payslipId);
    if (!CONFIRMED.includes(current.status))
      throw statusConflict(current.status);
    await this.prisma.$transaction(async (tx) => {
      await this.claim(tx, payslipId, current.status, dto.updatedAt, {
        status: 'REVIEWING',
        confirmedAt: null,
        confirmedBy: null,
      });
      // 확정이 찍은 확인 표시를 푼다(사유를 확인하는 것은 확정뿐이다) — 다시 검토 중이 된 명세서가 남은 사유로 검토 대기에
      // 들게(운영 정책 v221 PAY-06)
      const { count } = await tx.payslipReviewReason.updateMany({
        where: { payslipId, acknowledgedAt: { not: null } },
        data: { acknowledgedAt: null },
      });
      await tx.payslipLog.create({
        data: {
          payslipId,
          logType: 'CANCEL_CONFIRMATION',
          fromStatus: current.status,
          toStatus: 'REVIEWING',
          summary:
            count > 0
              ? `확정 취소 · 검토 사유 ${count}건 다시 검토 대기`
              : '확정 취소',
          changedBy: adminAccountId,
        },
      });
    });
    return this.detail.findOne(adminAccountId, payslipId);
  }

  /** 급여 기간에 걸친 체결 완료 근로계약 — 계산은 날마다 그날 계약으로 한다(2026-10-26) */
  private contractIdsOf(
    tx: Tx,
    current: {
      staffMemberId: number;
      periodStartDate: Date;
      periodEndDate: Date;
    },
  ): Promise<number[]> {
    return periodContractIds(
      tx,
      current.staffMemberId,
      current.periodStartDate,
      current.periodEndDate,
    );
  }

  /**
   * 검토 대기 사유를 지금 데이터로 모두 새로 판정한다 — 초안과 같은 규칙(`reviewReasonsOf`)으로, 확인 여부와 상관없이 지우고 다시
   * 만들어 「확인」 표시가 남지 않는다. 이력에 남길 「출퇴근 누락 해소」 · 「계약 만료 후 기록 추가」 모양의 말을 준다
   */
  private async refreshReviewReasons(
    tx: Tx,
    payslipId: number,
    current: {
      staffMemberId: number;
      periodStartDate: Date;
      periodEndDate: Date;
    },
    contractIds: readonly number[],
  ): Promise<string[]> {
    const where = {
      payslipId,
      reviewReason: { in: [...RECALCULATED_REASONS] },
    };
    const before = await tx.payslipReviewReason.findMany({
      where,
      select: { reviewReason: true },
    });
    const fresh = reviewReasonsOf(
      await attendanceReviewReasons(tx, {
        staffMemberId: current.staffMemberId,
        contractIds,
        periodStartDate: current.periodStartDate,
        periodEndDate: current.periodEndDate,
      }),
      contractIds,
      await contractsEmploymentMixed(tx, contractIds),
    );
    await tx.payslipReviewReason.deleteMany({ where });
    if (fresh.length)
      await tx.payslipReviewReason.createMany({
        data: fresh.map((r) => ({ ...r, payslipId })),
      });
    const label = (r: string) => REASON_LABEL[r] ?? r;
    return [
      ...before
        .filter((b) => !fresh.some((f) => f.reviewReason === b.reviewReason))
        .map((b) => `${label(b.reviewReason)} 해소`),
      ...fresh
        .filter((f) => !before.some((b) => b.reviewReason === f.reviewReason))
        .map((f) => `${label(f.reviewReason)} 추가`),
    ];
  }

  /**
   * 관리 범위 안에서 찾고, 가려지는 명세서(본사 역할 · 동의 없는 가맹 점포 직원)는 없는 것과 같은 404 — 상세와 같은 판정.
   * 사용 중인 관리자가 아니어도 404 다(상세와 같다).
   */
  private async locate(adminAccountId: number, payslipId: number) {
    const manageable = await this.scope.getManageableStores(adminAccountId);
    const found =
      manageable &&
      (await this.prisma.payslip.findFirst({
        where: {
          payslipId,
          storeId: { in: manageable.stores.map((s) => s.storeId) },
        },
        select: {
          storeId: true,
          staffMemberId: true,
          status: true,
          employmentType: true,
          periodStartDate: true,
          periodEndDate: true,
          isPremiumApplied: true,
          isWithholdingApplied: true,
          staffMember: { select: HQ_SHARING_SELECT },
        },
      }));
    if (
      !manageable ||
      !found ||
      hidesPersonalData(
        manageable.roleTypeCode,
        manageable.stores.find((s) => s.storeId === found.storeId),
        hqSharingConsentedOf(found.staffMember),
      )
    )
      throw new NotFoundException(PAYSLIP_NOT_FOUND_MESSAGE);
    return found;
  }

  /**
   * 읽은 상태 · updatedAt 을 조건으로 명세서를 먼저 고친다 — 행이 잠기고 updatedAt 이 바뀐다. 0건이면 지금 상태가 다르면
   * 409 PAYSLIP_STATUS_CONFLICT, 같으면 그사이 누가 고친 것이라 409 PAYSLIP_STALE.
   */
  private async claim(
    tx: Tx,
    payslipId: number,
    status: PayslipStatus,
    updatedAt: string,
    data: Prisma.PayslipUpdateManyMutationInput,
  ): Promise<void> {
    const { count } = await tx.payslip.updateMany({
      where: { payslipId, status, updatedAt: sameMillisecond(updatedAt) },
      data,
    });
    if (count > 0) return;
    const now = await tx.payslip.findUnique({
      where: { payslipId },
      select: { status: true },
    });
    if (now && now.status !== status) throw statusConflict(now.status);
    throw stale();
  }

  private lines(tx: Tx, payslipId: number): Promise<Line[]> {
    return tx.payslipItem.findMany({
      where: { payslipId },
      orderBy: ITEM_ORDER,
      select: LINE_SELECT,
    });
  }

  /** 받은 금액을 칸에 옮긴다. 시스템 계산값이 있는 줄은 그 값과 같거나 null 이면 계산값으로 돌린다(넣은 것으로 본다). */
  private nextValue(
    l: Line,
    amount: number | null,
  ): { adjustedAmount: number | null; isEntered: boolean } {
    if (l.payslipItemMaster.isSystemCalculated && l.calculatedAmount !== null)
      return {
        adjustedAmount:
          amount === null || amount === l.calculatedAmount ? null : amount,
        isEntered: true,
      };
    return { adjustedAmount: amount, isEntered: amount !== null };
  }
}
