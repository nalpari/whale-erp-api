import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ageOn } from '../contracts/contracts.service';
import { PrismaService } from '../prisma/prisma.service';
import { isBirthDateCorrectable } from './birth-date-correctable';
import { kstToday, parseDateOnly } from './kst-date';
import { STAFF_NOT_FOUND_MESSAGE } from './staff-menu';

export const BIRTH_DATE_INVALID_FORMAT_MESSAGE =
  '생년월일은 YYYY-MM-DD 형식의 있는 날짜여야 합니다.';
export const BIRTH_DATE_FUTURE_MESSAGE = '오늘 이후 날짜는 넣을 수 없습니다.';
export const BIRTH_DATE_UNDER_AGE_MESSAGE =
  '만 19세 미만으로 정정할 수 없습니다.';
export const BIRTH_DATE_NOT_JOINED_MESSAGE =
  '가입 전 직원은 생년월일을 정정할 수 없습니다.';
export const BIRTH_DATE_RETIRED_MESSAGE =
  '퇴직한 직원은 생년월일을 정정할 수 없습니다.';
export const BIRTH_DATE_UNCHANGED_MESSAGE = '지금 생년월일과 같습니다.';

const MIN_AGE = 19;

const badRequest = (code: string, message: string) =>
  new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    error: 'Bad Request',
    code,
    message,
  });

const conflict = (code: string, message: string) =>
  new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code,
    message,
  });

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

/**
 * 직원 생년월일 정정 (WHALEERP-602, 재영 TAX-09). 직원은 가입 뒤 생년월일을 고치지 않는다(ACC-13). 가입 때 잘못 넣어
 * 신고 정보의 주민등록번호 앞자리 검사(RRN_BIRTH_MISMATCH)에 걸리면 관리자가 확인해 정정한다.
 *
 * 생년월일은 계정(`accounts.birth_date`)에 하나라 같은 사람의 다른 BP 소속 레코드에도 같이 바뀐다 — 허용이고 따로
 * 알리지 않는다(재영 10-21). 계약서의 입력 · 본인인증 생년월일(`entered_birth_date` · `verified_birth_date`)은
 * 그 시점 값이라 건드리지 않고, 날인 대기 중인 계약이 있어도 막지 않는다(노영주).
 * 날인 대기 중인 계약은 날인 때 계약서 `entered_birth_date` 와 계정 생년월일을 다시 대조하므로, 정정으로 대조가 풀릴 수도
 * 있고(보통) 새로 어긋날 수도 있다. 계정 하나라 다른 BP 의 계약에도 같다.
 * 정정은 같은 트랜잭션에서 계정 변경 이력(BIRTH_DATE · ADMIN_CORRECTION)에 남긴다.
 */
@Injectable()
export class StaffBirthDateService {
  constructor(private readonly prisma: PrismaService) {}

  async correct(
    adminAccountId: number,
    staffMemberId: number,
    rawBirthDate: string,
    now?: Date,
  ): Promise<void> {
    const birthDate = parseDateOnly(rawBirthDate);
    if (!birthDate)
      throw badRequest('BIRTH_DATE_INVALID', BIRTH_DATE_INVALID_FORMAT_MESSAGE);
    await this.prisma.$transaction(async (tx) => {
      // 같은 직원에 대한 정정 · 퇴직이 겹쳐도 하나씩 지나가게 직원 행을 잠근다. FOR NO KEY UPDATE 라 계정을 먼저 잡은 직원 출근의 기록
      // insert(외래키 FOR KEY SHARE)를 막지 않는다 — 막으면 아래 계정 잠금과 엇갈려 교착한다(PR #159 리뷰)
      await tx.$queryRaw`SELECT 1 FROM staff_members WHERE staff_member_id = ${staffMemberId} FOR NO KEY UPDATE`;
      const staff = await tx.staffMember.findUnique({
        where: { staffMemberId },
        select: {
          accountId: true,
          employmentStatus: true,
          retiredDate: true,
        },
      });
      if (!staff) throw new NotFoundException(STAFF_NOT_FOUND_MESSAGE);
      const accountId = staff.accountId;
      if (accountId === null)
        throw conflict('BIRTH_DATE_NOT_JOINED', BIRTH_DATE_NOT_JOINED_MESSAGE);
      // 계정 행도 잠그고, 잠근 뒤 상태 · 생년월일을 읽는다. 같은 사람의 다른 소속 레코드로 겹쳐 오는 정정이나
      // 탈퇴(탈퇴가 생기면 같은 행을 잠그고 쓴다는 전제)가 이전 값을 어긋나게 읽지 않게 한다.
      await tx.$queryRaw`SELECT 1 FROM accounts WHERE account_id = ${accountId} FOR UPDATE`;
      // 시각은 잠금을 잡은 뒤에 잡는다. 기다린 시간만큼 지난 시각으로 판단하면 그 사이 지난 퇴직일 · 생일을 못 본다.
      // 테스트가 넣는 now 는 그대로 쓴다.
      const at = now ?? new Date();
      const today = kstToday(at);
      if (birthDate > today)
        throw badRequest('BIRTH_DATE_INVALID', BIRTH_DATE_FUTURE_MESSAGE);
      if (ageOn(rawBirthDate, isoDate(today)) < MIN_AGE)
        throw badRequest('BIRTH_DATE_UNDER_AGE', BIRTH_DATE_UNDER_AGE_MESSAGE);
      const current = await tx.account.findUniqueOrThrow({
        where: { accountId },
        select: { birthDate: true, status: true },
      });
      if (current.status !== 'JOINED')
        throw conflict('BIRTH_DATE_NOT_JOINED', BIRTH_DATE_NOT_JOINED_MESSAGE);
      // 퇴직 예정(퇴직일이 오늘이거나 그 뒤)은 허용한다. 퇴직일이 지났는데 배치가 아직 RETIRED 로 바꾸지 않은
      // 레코드도 퇴직으로 본다 — 직원 상세의 birthDateCorrectable 과 같은 판정(isBirthDateCorrectable).
      if (!isBirthDateCorrectable({ ...staff, account: current }, at))
        throw conflict('BIRTH_DATE_RETIRED', BIRTH_DATE_RETIRED_MESSAGE);

      if (current.birthDate.getTime() === birthDate.getTime())
        throw conflict('BIRTH_DATE_UNCHANGED', BIRTH_DATE_UNCHANGED_MESSAGE);

      await tx.account.update({
        where: { accountId },
        data: { birthDate },
      });
      await tx.accountChangeHistory.create({
        data: {
          accountId,
          field: 'BIRTH_DATE',
          beforeValue: isoDate(current.birthDate),
          afterValue: isoDate(birthDate),
          channel: 'ADMIN_CORRECTION',
          requestedBy: adminAccountId,
          changedAt: at,
        } satisfies Prisma.AccountChangeHistoryUncheckedCreateInput,
      });
    });
  }
}
