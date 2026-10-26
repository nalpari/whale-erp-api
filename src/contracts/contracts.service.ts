import { createHash } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  HttpStatus,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AttachmentFileType,
  ContractDraftAction,
  ContractStatus,
  Prisma,
  StaffMemberJoinStatus,
} from '@prisma/client';
import {
  AdminScopeService,
  hidesPersonalData,
} from '../admin-scope/admin-scope.service';
import {
  HQ_SHARING_CONSENTED,
  HQ_SHARING_SELECT,
  hqSharingConsentedOf,
  type HqSharingSource,
} from '../admin-scope/hq-sharing';
import { dateOnly } from '../common/date-only';
import { PrismaService } from '../prisma/prisma.service';
import { joinStateOf } from '../staff-members/join-state';
import { linkedRecords } from '../staff-members/previous-records';
import { DownloadUrlResponseDto } from '../storage/dto/download-url.response.dto';
import {
  requireStorage,
  STORAGE,
  type OptionalStorage,
} from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  checkReplace,
  checkWorkTimeOverlap,
  dropOrphanRecords,
  IN_PROGRESS,
  inProgressAtStore,
  InProgressContract,
  lockStaffForReplace,
  replaceContracts,
} from './contract-duplicates';
import { renewalDateOf } from './contract-renewal';
import { SIGNED_ONCE } from './signed-contract';
import {
  ContractDeliveryService,
  channelOf,
  deliveredStatusOf,
  type PendingInvite,
} from './contract-delivery.service';
import {
  fillHiredDate,
  lockContract,
  lockContractWithStaff,
  lockStaffMember,
  RESENDABLE_STATUSES,
  statusConflict,
  transition,
} from './contract-status';
import {
  ContractDetailDto,
  ContractListResponseDto,
} from './dto/contract.response.dto';
import {
  ContractWorkDayDto,
  CreateContractDto,
  CreatedContractResponseDto,
} from './dto/create-contract.dto';
import { ListContractsQueryDto } from './dto/list-contracts-query.dto';
import { CONTRACT_TERMS_SELECT, contractTermsOf, hhmm } from './contract-terms';
import { UpdateWorkerDto } from './dto/update-worker.dto';
import {
  ACCESS_DENIED_MESSAGE,
  ACCOUNT_UNAVAILABLE_MESSAGE,
} from '../auth/access-messages';
import {
  adminHasMenuAction,
  type MenuAction,
} from '../auth/menu-permission.guard';

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/**
 * 저장 응답의 draftAction — 시스템이 실제로 한 처리(WHALEERP-132). 보내지 않은 저장(임시저장 · 종이 계약 등록)은 null. 보냈으면 받는
 * 길을 보내기와 같은 channelOf 로 가른다 — 가입 초대 알림톡이면 가입 초대, 앱으로 받는 길이면 가입한 직원은 즉시 발송, 그 밖은
 * 판별한 소속 추가 확인 · 복귀 확인(판별값이 없는 옛 계약이면 나간 것이 없어 null). 계약에 저장하는 draftAction(종이 계약도 판별값을 남기고, 가입한 직원은 처음
 * 값을 그대로 둔다)과 다를 수 있다.
 */
function sentActionOf(
  sends: boolean,
  joined: boolean,
  draftAction: ContractDraftAction | null,
): ContractDraftAction | null {
  if (!sends) return null;
  if (channelOf(joined, draftAction) === 'INVITE') return 'SIGNUP_INVITE';
  if (joined) return 'IMMEDIATE_SEND';
  // 판별값이 없는 옛 계약의 가입 전 직원은 앱으로 받는 길이지만 받을 계정이 없어 아무것도 나가지 않는다
  return draftAction;
}

/** 상태별 개수의 빈 값 — 계약이 없는 상태도 0 으로 싣는다. 상태 enum 에서 만들어 새 상태가 생겨도 빠지지 않는다 */
const zeroStatusCounts = () =>
  Object.fromEntries(
    Object.values(ContractStatus).map((s) => [s, 0]),
  ) as Record<ContractStatus, number>;

/**
 * 이 계약을 직전 계약으로 둔 살아 있는 재계약 — 진행 중이거나 체결을 거친 것(WHALEERP-156). 거부 · 만료 · 체결 없이 종료(대체)된
 * 것은 치지 않는다. 한 계약에 살아 있는 재계약은 하나다.
 */
const LIVE_RENEWAL: Prisma.ContractWhereInput = {
  OR: [{ status: { in: IN_PROGRESS } }, SIGNED_ONCE],
};

/** 목록 줄의 직원 칸 — 이름, 상태 칸에 붙일 가입 · 초대 상태(joinStateOf, 직원 목록과 같은 재료)와 퇴직 여부 */
const LIST_STAFF_SELECT = {
  name: true,
  joinStatus: true,
  employmentStatus: true,
  invitations: {
    select: {
      invitationId: true,
      invitationType: true,
      status: true,
      sentAt: true,
      linkHolds: { where: { resolution: null }, select: { linkHoldId: true } },
    },
  },
} satisfies Prisma.StaffMemberSelect;
/** 근로자 정보를 고칠 수 있는 상태 — 발송한 뒤 날인 전(WHALEERP-125 · 126). 임시저장은 이어 쓰기로 고친다 */
const WORKER_EDITABLE: readonly ContractStatus[] = [
  'PENDING_SEND',
  'PENDING_SIGNATURE',
  'CORRECTION_REQUESTED',
];
/** 가입한 직원의 번호는 계정의 신원 기준 — 근로자 정보 수정 · 이어 쓰기에서 바꾸지 않는다(WHALEERP-125) */
const JOINED_PHONE_FIXED =
  '가입한 직원의 휴대전화번호는 바꿀 수 없습니다 — 계정의 번호가 기준입니다';
const WORKPLACE_FIXED =
  '수정 요청 근로계약서는 근무지를 바꿀 수 없습니다 — 다른 근무지는 새 근로계약서로 써 주세요';
/** 이어 쓰기 409 — 임시저장 · 수정 요청 근로계약서만 고친다 */
const EDITABLE_ONLY = '임시저장 · 수정 요청 근로계약서만 고칠 수 있습니다';

/** 근로계약 관리 메뉴 — 컨트롤러 경로(/contracts)가 메뉴 url 이다(경로 방식 @MenuPermission, menu-permission-urls 표) */
const CONTRACTS_MENU = { url: '/contracts' } as const;

/**
 * 근로계약 관리 메뉴 권한을 서비스가 다시 묻는다(WHALEERP-592). 가드는 경로만 봐서, 이어 쓰기 PUT 은 「작성 또는 수정」으로
 * 들어온다 — 상태를 읽은 뒤 임시저장이면 작성, 수정 요청이면 수정을 요구한다. 대체는 requireReplaceActions
 * 참고(2026-10-21 김민식). 없으면 가드와 같은 403.
 */
async function requireContractAction(
  db: Prisma.TransactionClient,
  adminAccountId: number,
  action: MenuAction,
  message = ACCESS_DENIED_MESSAGE,
): Promise<void> {
  if (!(await adminHasMenuAction(db, adminAccountId, CONTRACTS_MENU, [action])))
    throw new ForbiddenException(message);
}
/** 대체 403 꼬리 — 새로 쓰는 저장은 기존 임시저장을 이어 쓰면 되고, 이어 쓰기 · 근로자 정보 수정은 이미 다른 계약을 고치는 중이라 그럴 수 없다 */
const CONTINUE_DRAFT = '기존 임시저장을 이어 써 주세요';
const ASK_DELETER = '삭제 권한이 있는 관리자에게 맡겨 주세요';

/**
 * 대체 권한 — 진행 중 계약을 닫으니 수정, 임시저장은 행째 지우니(replaceContracts) 삭제를 요구한다. 임시저장만 대체하면
 * 닫는 계약이 없어 삭제만 본다(DELETE 한 뒤 저장하는 것과 같다, code-review). 삭제 권한 없이
 * 대체로 임시저장을 지우지 못하게 한다(api #97 리뷰, 2026-10-21 김민식). 409(checkReplace) 보다 먼저 물어, 권한이
 * 없으면 기존 계약의 이름 · 기간을 보이지 않는다. 403 은 공통 문구 대신 무엇이 막았고 어떻게 하면 되는지 알린다 — 화면의
 * 작성 버튼은 보이는 관리자다(이름 · 기간은 싣지 않는다).
 */
async function requireReplaceActions(
  db: Prisma.TransactionClient,
  adminAccountId: number,
  replaced: InProgressContract[],
  draftHint: string,
): Promise<void> {
  if (!replaced.length) return;
  // 종이 계약 등록은 체결 완료도 대체한다 — checkReplace 의 409 와 같은 말로
  const what = replaced.some((c) => c.status === 'SIGNED')
    ? '체결 완료되었거나 진행 중인'
    : '진행 중인';
  if (replaced.some((c) => c.status !== 'DRAFT'))
    await requireContractAction(
      db,
      adminAccountId,
      'update',
      `이 점포에 같은 직원의 ${what} 근로계약이 있습니다. 기존 계약을 대체하려면 근로계약 관리 수정 권한이 필요합니다`,
    );
  if (replaced.some((c) => c.status === 'DRAFT'))
    await requireContractAction(
      db,
      adminAccountId,
      'delete',
      `이 점포에 같은 직원의 임시저장 근로계약이 있습니다. 대체하면 임시저장을 지우므로 근로계약 관리 삭제 권한이 필요합니다 — ${draftHint}`,
    );
}
/** 이어 쓰기 403 — 동의로만 보는 관리자(점포 단위 범위 없음)가 번호를 바꾸거나, 다른 직원 레코드의 계약과 겹칠 때 */
const PHONE_CHANGE_FORBIDDEN =
  '휴대전화번호를 바꾸려면 점포 직원 관리 권한이 있어야 합니다. 번호를 바꾸지 않았다면 다른 요청이 먼저 고친 것이니 다시 열어 주세요';
const OTHER_RECORD_FORBIDDEN =
  '이 점포에 같은 번호로 다른 직원의 근로계약이 있습니다. 점포 직원 관리 권한이 있는 관리자가 처리해 주세요';
// date 컬럼은 UTC 자정, time 컬럼은 1970-01-01 의 그 시각으로 넘긴다. 시간대가 끼면 하루 · 몇 시간씩 밀린다.
const toDate = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
const toTime = (hm: string) => new Date(`1970-01-01T${hm}:00.000Z`);

/** on 날짜에 만 몇 살인지. 생일 당일에 한 살 는다. */
export function ageOn(birth: string, on: string): number {
  const [by, bm, bd] = birth.split('-').map(Number);
  const [oy, om, od] = on.split('-').map(Number);
  return oy - by - (om < bm || (om === bm && od < bd) ? 1 : 0);
}

// HH:mm 은 글자 비교가 시각 비교와 같다.
function checkWorkDay(d: ContractWorkDayDto) {
  if (d.endTime <= d.startTime)
    throw new BadRequestException(
      `${d.weekday}: 종업은 시업보다 뒤여야 합니다`,
    );
  if (!d.breakStartTime !== !d.breakEndTime)
    throw new BadRequestException(
      `${d.weekday}: 휴게는 시작과 종료를 함께 넣습니다`,
    );
  if (
    d.breakStartTime &&
    d.breakEndTime &&
    !(
      d.breakStartTime >= d.startTime &&
      d.breakEndTime > d.breakStartTime &&
      d.breakEndTime <= d.endTime
    )
  )
    throw new BadRequestException(
      `${d.weekday}: 휴게는 근무 시간 안이어야 합니다`,
    );
}

/** 저장 · 이어 쓰기가 같이 쓰는 입력 검사. 임시저장은 계약 칸을 비울 수 있어 넣은 값만 본다. */
function checkInput(dto: CreateContractDto): void {
  if (dto.startDate && dto.endDate && dto.endDate < dto.startDate)
    throw new BadRequestException('계약 종료일은 시작일보다 앞설 수 없습니다');
  // 운영 정책 ACC-22 — 계약 시작일 기준. 초대도 나가지 않는다.
  if (
    dto.birthDate &&
    dto.startDate &&
    ageOn(dto.birthDate, dto.startDate) < 19
  )
    throw new BadRequestException(
      '만 19세 미만 직원은 등록할 수 없습니다 (계약 시작일 기준)',
    );
  const workDays = dto.workDays ?? [];
  const weekdays = new Set(workDays.map((d) => d.weekday));
  if (weekdays.size !== workDays.length)
    throw new BadRequestException('같은 요일을 두 번 넣었습니다');
  workDays.forEach(checkWorkDay);
  checkWeeklyHoliday(dto);
  checkProbation(dto);
}

const minutesOf = (hm: string) =>
  Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

/** 주 소정근로시간(분) — 요일마다 종업 − 시업 − 휴게의 합 */
export function weeklyMinutesOf(workDays: ContractWorkDayDto[]): number {
  return workDays.reduce(
    (sum, d) =>
      sum +
      minutesOf(d.endTime) -
      minutesOf(d.startTime) -
      (d.breakStartTime && d.breakEndTime
        ? minutesOf(d.breakEndTime) - minutesOf(d.breakStartTime)
        : 0),
    0,
  );
}

/**
 * 주휴일(노무사 확인 2026-10-14, 질문 4) — 주 소정근로시간이 15시간 이상이면 근무하지 않는 요일 하나를 관리자가 고른다.
 * 15시간 미만이면 주휴가 없어 비운다(운영 정책 PAY-02). 임시저장은 근무 요일 · 주휴일을 비울 수 있어 넣은 값만 본다.
 */
function checkWeeklyHoliday(dto: CreateContractDto): void {
  const { workDays, weeklyHoliday } = dto;
  if (!workDays) return;
  if (weeklyMinutesOf(workDays) < 15 * 60) {
    if (weeklyHoliday)
      throw new BadRequestException(
        '주 소정근로시간이 15시간 미만이면 주휴일이 없습니다',
      );
    return;
  }
  if (!weeklyHoliday) {
    if (dto.isTemporarySave) return;
    throw new BadRequestException(
      '주 소정근로시간이 15시간 이상이면 주휴일을 골라야 합니다',
    );
  }
  if (workDays.some((d) => d.weekday === weeklyHoliday))
    throw new BadRequestException('주휴일은 근무하지 않는 요일이어야 합니다');
}

/** start 부터 1년이 되는 날(그날 포함) — 2026-01-01 이면 2026-12-31 */
function oneYearLastDay(start: string): string {
  const d = toDate(start);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  d.setUTCDate(d.getUTCDate() - 1);
  return isoDate(d);
}

/**
 * 수습(노무사 확인 2026-10-14, 질문 19) — 정직원이고 계약 기간이 1년 이상이거나 기간의 정함이 없을 때만 둔다.
 * 기간(1~3개월) · 감액률(0~10%)은 함께 넣는다. 최저임금 90% 확인은 최저임금을 시스템이 관리하기 전까지 화면이 한다.
 */
function checkProbation(dto: CreateContractDto): void {
  const months = dto.probationMonths ?? null;
  const rate = dto.probationWageReductionRate ?? null;
  if ((months === null) !== (rate === null))
    throw new BadRequestException('수습 기간과 임금 감액률은 함께 넣습니다');
  if (months === null) return;
  if (dto.employmentType !== 'FULL_TIME')
    throw new BadRequestException('수습은 정직원만 둘 수 있습니다');
  if (
    dto.startDate &&
    dto.endDate &&
    dto.endDate < oneYearLastDay(dto.startDate)
  )
    throw new BadRequestException(
      '수습은 계약 기간이 1년 이상이거나 기간의 정함이 없을 때만 둘 수 있습니다',
    );
}

/**
 * 임시저장은 상태만 다르다. 지금은 초안 저장도 초대를 보내지 않는다 — 초대 발송이 생기면 여기서 갈린다.
 * 종이 계약은 당사자가 모두 날인한 파일을 함께 받으므로 발송 · 날인 없이 체결 완료다(CTR-23).
 */
const statusOf = (dto: CreateContractDto) =>
  dto.isTemporarySave
    ? ('DRAFT' as const)
    : dto.contractMethod === 'PAPER'
      ? ('SIGNED' as const)
      : ('PENDING_SEND' as const);

/** 종이 계약 날인본 한 개. 근로계약서는 필수, 따로 날인한 임금계약서는 선택이다(2026-10-06 재영). */
export interface PaperDocument {
  kind: 'PAPER_EMPLOYMENT_CONTRACT' | 'WAGE_CONTRACT';
  /** 올린 파일의 원래 이름 — 내려받으면 이 이름으로 저장된다 */
  fileName: string;
  buffer: Buffer;
  /** 내용으로 판정한 종류(assertUpload) */
  fileType: AttachmentFileType;
}

/**
 * 종이 계약과 날인본의 짝을 본다. 종이 계약 등록(임시저장이 아님)은 근로계약서 날인본이 있어야 하고, 날인본은
 * 종이 계약 등록에서만 받는다 — 전자계약 · 임시저장에 파일을 실으면 400(저장하지 않을 파일을 올리지 않게).
 */
function checkPaper(
  dto: CreateContractDto,
  documents: readonly PaperDocument[],
): void {
  const registering = dto.contractMethod === 'PAPER' && !dto.isTemporarySave;
  if (!registering && documents.length)
    throw new BadRequestException(
      '날인본 파일은 종이 계약을 등록할 때만 올릴 수 있습니다',
    );
  if (
    registering &&
    !documents.some((d) => d.kind === 'PAPER_EMPLOYMENT_CONTRACT')
  )
    throw new BadRequestException(
      '종이 계약은 당사자가 모두 날인한 근로계약서 파일과 함께 등록합니다',
    );
}

/** 날인본을 저장소에 올리고 contract_documents 행을 만든다. 올린 키는 uploaded 에 쌓는다 — 실패하면 부른 쪽이 지운다. */
async function saveDocuments(
  tx: Prisma.TransactionClient,
  storage: StorageService,
  contractId: number,
  documents: readonly PaperDocument[],
  uploaded: string[],
  logger: Logger,
): Promise<void> {
  if (!documents.length) return;
  const rows: Prisma.ContractDocumentCreateManyInput[] = [];
  for (const d of documents) {
    const key = StorageService.newKey('contracts', contractId, d.fileType);
    uploaded.push(key);
    try {
      await storage.put(key, d.buffer, d.fileType);
    } catch (error) {
      // 권한 · 버킷 설정 · 네트워크 오류는 화면에 같은 503 이다 — 원인은 여기에만 남는다(점포 이미지 putImage 와 같다).
      logger.error(
        `날인본 올리기 실패 contractId=${contractId} key=${key}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new ServiceUnavailableException(
        '날인본을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요',
      );
    }
    rows.push({
      contractId,
      kind: d.kind,
      storageKey: key,
      checksum: createHash('sha256').update(d.buffer).digest('hex'),
      fileName: d.fileName,
    });
  }
  await tx.contractDocument.createMany({ data: rows });
}

/** contracts 칸. 비운 칸은 NULL 로 덮는다 — 이어 쓰기는 폼 전체를 다시 받는다. */
function contractFields(dto: CreateContractDto) {
  return {
    storeId: dto.storeId,
    employmentType: dto.employmentType,
    contractMethod: dto.contractMethod ?? null,
    startDate: dto.startDate ? toDate(dto.startDate) : null,
    endDate: dto.endDate ? toDate(dto.endDate) : null,
    workLocation: dto.workLocation ?? null,
    weeklyHoliday: dto.weeklyHoliday ?? null,
    wageAmount: dto.wageAmount ?? null,
    mealAllowanceAmount: dto.mealAllowanceAmount ?? null,
    carAllowanceAmount: dto.carAllowanceAmount ?? null,
    childcareAllowanceAmount: dto.childcareAllowanceAmount ?? null,
    baseHours: dto.baseHours ?? null,
    monthlyOvertimeHours: dto.monthlyOvertimeHours ?? null,
    baseNightHours: dto.baseNightHours ?? null,
    baseHolidayHours: dto.baseHolidayHours ?? null,
    monthlyExtraHolidayHours: dto.monthlyExtraHolidayHours ?? null,
    annualLeaveTerms: dto.annualLeaveTerms ?? null,
    severancePayTerms: dto.severancePayTerms ?? null,
    payMonth: dto.payMonth ?? null,
    payDay: dto.payDay ?? null,
    payMethod: dto.payMethod ?? null,
    probationMonths: dto.probationMonths ?? null,
    probationWageReductionRate: dto.probationWageReductionRate ?? null,
    isHealthPensionInsured: dto.isHealthPensionInsured ?? null,
    isEmploymentInjuryInsured: dto.isEmploymentInjuryInsured ?? null,
    status: statusOf(dto),
  };
}

const workDayRows = (dto: CreateContractDto) =>
  (dto.workDays ?? []).map((d) => ({
    weekday: d.weekday,
    startTime: toTime(d.startTime),
    endTime: toTime(d.endTime),
    breakStartTime: d.breakStartTime ? toTime(d.breakStartTime) : null,
    breakEndTime: d.breakEndTime ? toTime(d.breakEndTime) : null,
  }));

const partyFields = (dto: CreateContractDto) => ({
  enteredName: dto.name,
  enteredPhone: dto.phone,
  enteredBirthDate: dto.birthDate ? toDate(dto.birthDate) : null,
  enteredGender: dto.gender ?? null,
  isForeigner: dto.isForeigner ?? false,
});

const staffMemberFields = (dto: CreateContractDto) => ({
  storeId: dto.storeId,
  name: dto.name,
  phone: dto.phone,
  employmentType: dto.employmentType,
  jobTitle: dto.jobTitle,
});

export type Invitation = {
  draftAction:
    'SIGNUP_INVITE' | 'AFFILIATION_CONFIRM' | 'RETURN_CONFIRM' | null;
  candidateAccountId: number | null;
};
const NOT_YET: Invitation = { draftAction: null, candidateAccountId: null };

/**
 * 초대 유형 판별 (목업 contracts-new 「초대 유형 판별 규칙」). 휴대전화번호로 계정을 찾고 이 점포의 그 계정 레코드를 본다.
 *   계정 없음 → 가입 초대 / 계정 있음 · 이 점포 레코드 없음 → 소속 추가 확인 / 퇴직 레코드 → 복귀 확인 / 재직 중 → 409.
 * 번호는 고유가 아니어서(번호를 넘겨받는 일이 있다) 탈퇴하지 않은 계정 중 가장 최근에 만든 것을 본다. 재초대는 「초대 재발송」의 일이라 여기 없다.
 * 판별만 남긴다 — 발송이 생기기 전까지 invitations 행 · 토큰 · join_status INVITED 는 만들지 않는다(「발송했다」가 아니므로).
 */
export async function decideInvitation(
  db: Prisma.TransactionClient,
  storeId: number,
  phone: string,
): Promise<Invitation> {
  const accountId = await accountOfPhone(db, phone);
  if (accountId === null)
    return { draftAction: 'SIGNUP_INVITE', candidateAccountId: null };
  const records = await db.staffMember.findMany({
    where: { storeId, accountId },
    select: { employmentStatus: true },
  });
  if (records.some((r) => r.employmentStatus === 'EMPLOYED'))
    throw new ConflictException('이 점포에 이미 재직 중인 직원입니다');
  return {
    draftAction: records.length ? 'RETURN_CONFIRM' : 'AFFILIATION_CONFIRM',
    candidateAccountId: accountId,
  };
}

/**
 * 그 번호의 계정. 번호는 고유가 아니어서 탈퇴하지 않은 계정 중 가장 최근에 만든 것을 본다 — 탈퇴 계정은 없는 것으로 본다
 * (그 번호의 사람은 새로 가입한다, api #59 리뷰, email-find 와 같은 기준).
 */
async function accountOfPhone(
  db: Prisma.TransactionClient,
  phone: string,
): Promise<number | null> {
  const [account] = await db.account.findMany({
    where: { phone, status: { not: 'WITHDRAWN' } },
    select: { accountId: true },
    orderBy: [{ createdAt: 'desc' }, { accountId: 'desc' }],
    take: 1,
  });
  return account?.accountId ?? null;
}

/**
 * 재입사 레코드가 이을 같은 사람의 직전 재직 레코드(WHALEERP-615, 2026-10-22 김민식). 퇴직 뒤 다시 입사하면 새 레코드를
 * 만들므로(api #65) 직원 상세가 이 칸을 따라 이전 재직 기간을 보인다. 같은 점포의 퇴직(예정) 레코드 가운데 같은 사람 —
 * 같은 이름이고, 그 번호의 계정 레코드(복귀 확인)이거나 같은 번호의 가입 전 레코드 — 에서 가장 늦게 퇴직한 것이고, 없으면
 * null 이다. 이름이 다르면 번호를 넘겨받은 다른 사람일 수 있어 잇지 않는다(가입 전 레코드 다시 쓰기와 같은 기준). 계정은
 * 초대 유형 판별과 같은 기준으로 여기서 찾는다 — 임시저장은 판별하지 않아 후보 계정이 비어 있다. 가입 전 레코드를 쓸 때마다
 * 다시 찾는다(이어 쓰기 · 근로자 정보 수정으로 이름 · 번호가 바뀐다). 가입한 레코드는 이름 · 번호가 계정 값이라 저장으로
 * 바뀌지 않아 다시 찾지 않는다. 이미 있는 레코드(staffMemberId)는 자기 자신과, 건너서라도 자기를 이은 레코드를 잇지 않는다
 * — 사슬이 돌지 않게.
 */
async function previousRecordOf(
  db: Prisma.TransactionClient,
  who: { storeId: number; name: string; phone: string },
  staffMemberId?: number,
): Promise<number | null> {
  const accountId = await accountOfPhone(db, who.phone);
  const later =
    staffMemberId === undefined
      ? []
      : await linkedRecords(db, staffMemberId, who.storeId, 'later');
  const previous = await db.staffMember.findFirst({
    where: {
      storeId: who.storeId,
      name: who.name,
      retiredDate: { not: null },
      OR: [
        ...(accountId === null ? [] : [{ accountId }]),
        { accountId: null, phone: who.phone },
      ],
      ...(staffMemberId !== undefined && {
        staffMemberId: {
          notIn: [staffMemberId, ...later.map((r) => r.staffMemberId)],
        },
      }),
    },
    orderBy: [{ retiredDate: 'desc' }, { staffMemberId: 'desc' }],
    select: { staffMemberId: true },
  });
  return previous?.staffMemberId ?? null;
}

/** 재계약(WHALEERP-156)의 연장 — 새 계약을 붙일 직전 계약의 직원 레코드 */
type RenewalRecord = {
  staffMemberId: number;
  joinStatus: StaffMemberJoinStatus;
  candidateAccountId: number | null;
};

/**
 * 재계약의 직전 계약을 확인한다(번호 잠금 뒤). 같은 근무지 · 같은 번호여야 하고(400), 체결 완료이거나 체결 뒤 종료된 계약이어야
 * 하며 이미 살아 있는 재계약이 있으면 안 된다(409 — 같은 계약에서 체결 완료가 둘 생기지 않게, api 재계약 리뷰). 그 직원이 재직
 * 중이면 연장이라 같은 레코드를 쓰고, 퇴직했거나 퇴직일을 정했으면 재입사라 지금처럼 새 레코드를 만든다(2026-10-26 김민식) —
 * 가입한 직원이 퇴직 예정이면 그 레코드가 아직 재직이라 checkNotEmployed 가 409 다(퇴직 뒤에 재입사). 직원 행을 write 로 잠근
 * 뒤 읽는다 — 읽은 뒤 퇴직 확정이 끼어 퇴직 레코드에 새 계약이 붙지 않게. 범위는 부르는 쪽이 트랜잭션 밖에서 본다.
 */
async function renewalOf(
  db: Prisma.TransactionClient,
  dto: CreateContractDto,
  previousContractId: number,
): Promise<RenewalRecord | null> {
  // 계약의 직원은 만들 때만 정해져 잠그기 전에 읽어도 된다
  const head = await db.contract.findUnique({
    where: { contractId: previousContractId },
    select: { staffMemberId: true },
  });
  if (!head) throw new NotFoundException(CONTRACT_NOT_FOUND);
  await lockStaffMember(db, head.staffMemberId, 'write');
  const previous = await db.contract.findFirst({
    where: { contractId: previousContractId, ...SIGNED_ONCE },
    select: {
      storeId: true,
      contractsAsPrevious: {
        where: LIVE_RENEWAL,
        select: { contractId: true },
        take: 1,
      },
      staffMember: {
        select: {
          staffMemberId: true,
          phone: true,
          joinStatus: true,
          employmentStatus: true,
          retiredDate: true,
          candidateAccountId: true,
        },
      },
    },
  });
  if (!previous)
    throw new ConflictException(
      '체결 완료되었거나 체결 뒤 종료된 근로계약만 재계약할 수 있습니다',
    );
  if (previous.contractsAsPrevious.length)
    throw new ConflictException(
      '이미 재계약한 근로계약입니다. 이어지는 근로계약을 확인해 주세요',
    );
  if (previous.storeId !== dto.storeId)
    throw new BadRequestException(
      '재계약은 직전 계약과 같은 근무지로만 할 수 있습니다',
    );
  const s = previous.staffMember;
  if (s.phone !== dto.phone)
    throw new BadRequestException(
      '재계약은 직전 계약과 같은 휴대전화번호로만 할 수 있습니다',
    );
  // 연장(재직 중 — 퇴직 · 퇴직 예정이 아님)이면 같은 레코드, 재입사면 null(새 레코드)
  const employed = s.employmentStatus === 'EMPLOYED' && s.retiredDate === null;
  return employed
    ? {
        staffMemberId: s.staffMemberId,
        joinStatus: s.joinStatus,
        candidateAccountId: s.candidateAccountId,
      }
    : null;
}

/**
 * 직전 계약을 고르지 않은 저장이 이어 붙을 재계약의 직전 계약(WHALEERP-130 · 156, 2026-10-26 재영 확정 — 재직 중인 직원에게 새 계약을
 * 보내는 것이 곧 재계약이다). 이 점포에 같은 번호로 가입한 재직 직원이 있으면 그 레코드의 가장 최근 체결을 거친 계약(시작일 ·
 * id 가 가장 늦은 것)이다. 없으면 undefined — 재직 직원이 없거나, 체결을 거친 계약이 없는 가입 레코드(진행 중 계약만)는 지금처럼
 * 같은 점포 재직 409 다. 번호 잠금 · 직원 행 잠금 뒤에 부른다.
 */
async function employedRenewalOf(
  db: Prisma.TransactionClient,
  dto: CreateContractDto,
): Promise<number | undefined> {
  const latest = await db.contract.findFirst({
    where: {
      storeId: dto.storeId,
      staffMember: {
        storeId: dto.storeId,
        phone: dto.phone,
        joinStatus: 'JOINED',
        employmentStatus: 'EMPLOYED',
      },
      ...SIGNED_ONCE,
    },
    orderBy: [{ startDate: 'desc' }, { contractId: 'desc' }],
    select: { contractId: true },
  });
  return latest?.contractId;
}

/**
 * 이 점포에 같은 번호로 가입한 재직 직원이 있으면 409. 가입 전 레코드(초안 · 초대)는 보지 않는다 — 재직 상태가
 * 기본값이라, 계약이 거부 · 만료로 끝나 레코드가 남으면 그 사람의 새 초안을 영영 막는다. 같은 사람의 진행 중인
 * 계약을 대체할지 묻는 것은 계약 중복 검사(WHALEERP-129)의 일이다.
 */
async function checkNotEmployed(
  db: Prisma.TransactionClient,
  dto: CreateContractDto,
  exceptStaffMemberId?: number,
): Promise<void> {
  const employed = await db.staffMember.findFirst({
    where: {
      storeId: dto.storeId,
      phone: dto.phone,
      joinStatus: 'JOINED',
      employmentStatus: 'EMPLOYED',
      ...(exceptStaffMemberId !== undefined && {
        staffMemberId: { not: exceptStaffMemberId },
      }),
    },
    select: { staffMemberId: true },
  });
  if (employed)
    throw new ConflictException(
      '이 점포에 같은 번호로 재직 중인 직원이 있습니다',
    );
}

/**
 * 같은 번호의 근로계약 쓰기를 줄 세운다 — 재직 확인 · 중복 검사 · 초대 유형 판별과 쓰기 사이에 다른 요청이 끼지
 * 않게(저장 두 번 누름 · 요청 겹침). 다른 점포 근무 시간 겹침도 보므로 점포가 아니라 사람(번호) 단위다.
 * 번호가 둘이면(이어 쓰기로 번호를 바꿈) 정한 순서(오름차순)로 잡는다 — 엇갈리면 교착이 된다.
 * 트랜잭션이 끝나면 풀린다. 계약 행 잠금보다 먼저 잡는다.
 */
export async function lockPeople(
  db: Prisma.TransactionClient,
  phones: string[],
): Promise<void> {
  for (const phone of [...new Set(phones)].sort())
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`contracts:${phone}`}))`;
}

const CONTRACT_NOT_FOUND = '근로계약을 찾을 수 없습니다';
/** 날인본을 올리는 쓰기 트랜잭션의 제한 시간 — 업로드가 안에서 돈다 */
const PAPER_TRANSACTION_TIMEOUT_MS = 60_000;

/** 범위를 본 뒤 잠그기 전에 다른 요청이 근무지를 옮겼으면 409 — 옮긴 근무지의 범위는 보지 않았다. */
function sameStore(storeId: number, scoped: number): void {
  if (storeId !== scoped)
    throw new ConflictException(
      '다른 요청이 먼저 근무지를 고쳤습니다. 다시 열어 주세요',
    );
}
const STORE_NOT_FOUND = '근무지 점포를 찾을 수 없습니다';

/**
 * 관리자의 업무 범위(AdminScopeService)로 거른다. 관리하지 않는 점포의 계약, 그리고 본사 역할(BM · BA)에게 직영이
 * 아닌 점포에서 본사 제공 동의하지 않은 직원의 계약은 없는 것과 같다(404, 목록에서 빠짐) — 계약은 직원 개인
 * 정보(이름 · 번호 · 생년월일 · 임금)라 직원 단위 API 와 같은 기준(hidesPersonalData)을 쓴다. 직원이 정해진 기존
 * 계약은 그 직원의 동의로, 직원이 아직 없는 새 계약의 근무지는 점포 단위로 판단한다(2026-10-13 재영, api #21) —
 * 직원 목록이 동의한 직원 행에 내보내는 계약 ID 로 열었을 때 404 가 나지 않게.
 */
@Injectable()
export class ContractsService {
  private readonly logger = new Logger(ContractsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: AdminScopeService,
    @Inject(STORAGE) private readonly storage: OptionalStorage,
    private readonly delivery: ContractDeliveryService,
  ) {}

  /**
   * 쓰기 트랜잭션을 돌리고, 실패하면 그 안에서 올린 날인본을 저장소에서 지운다(첨부 저장소 규칙 — put 뒤 DB 저장이
   * 실패하면 delete). 날인본이 없으면 저장소를 부르지 않는다(설정이 없는 환경에서도 전자계약은 저장된다).
   */
  private async withDocuments<T>(
    documents: readonly PaperDocument[],
    work: (
      tx: Prisma.TransactionClient,
      save: (contractId: number) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    const storage = documents.length ? requireStorage(this.storage) : null;
    const uploaded: string[] = [];
    try {
      return await this.prisma.$transaction(
        (tx) =>
          work(tx, (contractId) =>
            storage
              ? saveDocuments(
                  tx,
                  storage,
                  contractId,
                  documents,
                  uploaded,
                  this.logger,
                )
              : Promise.resolve(),
          ),
        // 날인본(하나에 10MB, 둘까지)은 계약 행이 생긴 뒤 키(contracts/{id}/…)가 정해져 트랜잭션 안에서 올린다. 기본
        // 5초로는 느린 업로드가 P2028 로 롤백돼 60초를 준다. 그동안 같은 번호의 다른 계약 쓰기(같은 advisory lock)는 기다린다.
        documents.length
          ? { timeout: PAPER_TRANSACTION_TIMEOUT_MS }
          : undefined,
      );
    } catch (error) {
      // 날인본은 썸네일이 없어 원본만 지우고, 키들을 한꺼번에 지운다 — S3 가 멈춰도 정리는 삭제 기한(25초) 한 번만 기다린다.
      if (storage)
        await Promise.all(
          uploaded.map((key) =>
            storage
              .delete(key, { thumbnail: false })
              .catch((e: unknown) =>
                this.logger.warn(`날인본 정리 실패 ${key}: ${String(e)}`),
              ),
          ),
        );
      // 같은 번호의 쓰기는 advisory lock 에 줄을 선다 — 날인본 업로드(최대 60초)를 기다리다 시간을 넘기면 장애가 아니라
      // 다시 시도할 일이다(점포 등록과 같은 처리). 날인본 등록 자신이 60초를 넘겨도 같다.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2028'
      ) {
        this.logger.error(
          `근로계약 쓰기 트랜잭션 시간 초과 documents=${documents.length}`,
          error.stack,
        );
        throw new ServiceUnavailableException(
          '저장이 몰렸습니다. 잠시 뒤 다시 저장해 주세요',
        );
      }
      throw error;
    }
  }

  /** 근무지로 고를 수 있는 점포인가 — 지우지 않고, 폐점하지 않았고, 업무 범위 안. 아니면 404. */
  private async checkStore(
    adminAccountId: number,
    storeId: number,
  ): Promise<void> {
    await this.checkStoreOpen(storeId);
    if (!(await this.scope.canManageStaffAt(adminAccountId, storeId, false)))
      throw new NotFoundException(STORE_NOT_FOUND);
  }

  /** 지우지 않고 폐점하지 않은 점포인가. 아니면 404. 업무 범위는 보지 않는다. */
  private async checkStoreOpen(storeId: number): Promise<void> {
    const store = await this.prisma.store.findFirst({
      where: { storeId, isDeleted: false, storeStatusCode: { not: 'CLOSED' } },
      select: { storeId: true },
    });
    if (!store) throw new NotFoundException(STORE_NOT_FOUND);
  }

  /** 업무 범위 밖의 계약은 없는 계약과 같게 404 다. 계약 직원의 본사 제공 동의로 판단한다. */
  private async checkContractScope(
    adminAccountId: number,
    c: {
      storeId: number;
      staffMember: HqSharingSource;
    },
  ): Promise<void> {
    if (
      !(await this.scope.canManageStaffAt(
        adminAccountId,
        c.storeId,
        hqSharingConsentedOf(c.staffMember),
      ))
    )
      throw new NotFoundException(CONTRACT_NOT_FOUND);
  }

  /**
   * 이어 쓰기 · 삭제 전에 그 계약의 근무지가 업무 범위 안인지 본다. 트랜잭션 밖에서 한다 — AdminScopeService 는
   * 자기 연결로 묻기 때문에 트랜잭션 안에서 부르면 요청 하나가 연결을 둘 잡아, 몰리면 풀이 말라 서로를 기다린다.
   * 트랜잭션 안에서는 근무지가 그사이 바뀌지 않았는지(sameStore)만 본다.
   */
  private async scopedStoreOf(
    adminAccountId: number,
    contractId: number,
  ): Promise<number> {
    return (await this.scopedContractOf(adminAccountId, contractId)).storeId;
  }

  /** scopedStoreOf 와 같고, 그때 읽은 직원 번호도 준다(이어 쓰기가 번호를 바꾸는지 본다). */
  async scopedContractOf(
    adminAccountId: number,
    contractId: number,
  ): Promise<{ storeId: number; phone: string }> {
    const c = await this.prisma.contract.findUnique({
      where: { contractId },
      select: {
        storeId: true,
        staffMember: { select: { ...HQ_SHARING_SELECT, phone: true } },
      },
    });
    if (!c) throw new NotFoundException(CONTRACT_NOT_FOUND);
    await this.checkContractScope(adminAccountId, c);
    return { storeId: c.storeId, phone: c.staffMember.phone };
  }

  /**
   * 근로계약서 초안 저장. 발송 대기(임시저장이면 임시저장) 계약을 만들고, 이 점포에 같은 번호의 가입 전 직원
   * 레코드가 있으면 그것에, 없으면 새 미가입 레코드에 잇는다. 같은 점포의 진행 중 계약은 대체를 확인받고 닫으며,
   * 초안 저장이면 다른 점포 근무 시간 겹침을 막는다(WHALEERP-129). 한 트랜잭션이라 중간에 실패하면 아무것도
   * 남지 않는다. 초안 저장(전자계약)이면 곧바로 보낸다(2026-10-19 재영) — 가입 초대면 발송 대기와 커밋 뒤 알림톡, 앱으로
   * 받는 직원이면 서명 대기(앱 알림은 아직 없어 보내지 않는다). ContractDeliveryService 참고.
   */
  async create(
    dto: CreateContractDto,
    adminAccountId: number,
    documents: readonly PaperDocument[] = [],
  ): Promise<CreatedContractResponseDto> {
    checkInput(dto);
    checkPaper(dto, documents);
    await this.checkStore(adminAccountId, dto.storeId);
    // 재계약이면 직전 계약도 이 관리자의 범위 안이어야 한다(없거나 범위 밖이면 404 · 403)
    if (dto.previousContractId !== undefined)
      await this.scopedContractOf(adminAccountId, dto.previousContractId);
    const fields = contractFields(dto);
    const now = new Date();

    const { result, pending } = await this.withDocuments<{
      result: CreatedContractResponseDto;
      pending: PendingInvite | null;
    }>(documents, async (tx, saveDocuments) => {
      await lockPeople(tx, [dto.phone]);
      // 대체할 수 있는 직원 행을 id 순으로 먼저 — 대체가 계약 id 순으로 하나씩 잡으면 하루 배치와 엇갈린다(api #150 리뷰). 재계약의
      // 직전 계약 직원 행도 같은 점포 · 번호라 여기서 함께 잡힌다
      await lockStaffForReplace(tx, dto.storeId, dto.phone);
      // 재계약(연장)은 직전 계약의 직원 레코드에 붙인다 — 가입한 재직 직원이어도 막지 않는다(WHALEERP-156). 직전 계약을 고르지
      // 않아도 이 점포에 가입한 재직 직원이 있으면 그 사람의 최근 체결 계약에 잇는 재계약이다(WHALEERP-130, 2026-10-26 재영)
      const previousContractId =
        dto.previousContractId ?? (await employedRenewalOf(tx, dto));
      const sameRecord =
        previousContractId === undefined
          ? null
          : await renewalOf(tx, dto, previousContractId);
      const joined = sameRecord?.joinStatus === 'JOINED';
      // 목업의 초대 유형 판별 「이 점포 재직 중 → 차단」. 계정 조회 전이라도 레코드로 막을 수 있다.
      await checkNotEmployed(tx, dto, sameRecord?.staffMemberId);
      // 종이 계약 등록은 곧바로 체결 완료라 같은 점포의 체결 완료 계약도 대체를 묻는다(두 번 누름 · 재시도 방지). 재계약의 직전
      // 계약은 대체하지 않는다 — 새 계약 시작일에 하루 배치가 종료로 바꾼다.
      const replaced = (
        await inProgressAtStore(
          tx,
          dto.storeId,
          dto.phone,
          undefined,
          fields.status === 'SIGNED',
        )
      ).filter((c) => c.contractId !== previousContractId);
      await requireReplaceActions(tx, adminAccountId, replaced, CONTINUE_DRAFT);
      checkReplace(replaced, dto.replaceContractIds);
      await replaceContracts(tx, replaced, dto);
      // 다른 점포 근무 시간 겹침은 발송 전(초안 저장)에 본다. 임시저장은 근무 시간이 다 정해지지 않았을 수 있다.
      if (fields.status !== 'DRAFT') await checkWorkTimeOverlap(tx, dto);
      // 임시저장은 판별하지 않는다 — 초안 저장(발송 대기)으로 넘어갈 때 한다. 가입한 직원의 재계약은 판별하지 않는다 — 자기
      // 레코드가 재직이라 판별이 늘 「이미 재직 중」이 된다. 앱으로 받는다(이어 쓰기의 가입한 직원과 같다).
      const invite: Invitation =
        fields.status === 'DRAFT'
          ? NOT_YET
          : joined
            ? {
                draftAction: null,
                candidateAccountId: sameRecord.candidateAccountId,
              }
            : await decideInvitation(tx, dto.storeId, dto.phone);
      // 초안 저장(전자계약)은 보낸 뒤의 상태로 만든다 — 가입 초대면 발송 대기, 계정이 있는 번호면 서명 대기
      const sends = fields.status === 'PENDING_SEND';
      const status = sends
        ? deliveredStatusOf(joined, invite.draftAction)
        : fields.status;
      const contract = {
        ...fields,
        status,
        draftAction: invite.draftAction,
        previousContractId: previousContractId ?? null,
        createdBy: adminAccountId,
        contractParty: { create: partyFields(dto) },
        contractWorkDays: { create: workDayRows(dto) },
        contractStatusHistories: {
          create: { toStatus: status, actor: 'ADMIN' as const },
        },
      };
      // 보낼 준비(서명 기한 · 초대) — 새 계약이라 되돌리면 임시저장이 된다
      const deliver = (
        contractId: number,
        staffMemberId: number,
        staffMember: { joinStatus: string; candidateAccountId: number | null },
      ) =>
        sends
          ? this.delivery.prepare(
              tx,
              {
                contractId,
                storeId: dto.storeId,
                phone: dto.phone,
                joined,
                draftAction: invite.draftAction,
                before: {
                  status: null,
                  sentAt: null,
                  signDeadlineAt: null,
                  draftAction: null,
                  staffMemberId,
                  staffMember,
                },
                statusChanged: true,
                phoneChanged: false,
                replacedContracts: replaced.length > 0,
              },
              now,
            )
          : Promise.resolve(null);

      // 이 점포에 같은 번호 · 같은 이름의 가입 전 레코드가 있으면 다시 쓴다 — 초안마다 레코드가 생겨 같은 사람이
      // 여럿 되지 않게. 이름이 다르면 번호를 넘겨받은 다른 사람일 수 있어 새 레코드를 만든다 — 앞사람 레코드의 이름을
      // 바꾸거나 앞사람의 지난 계약을 새 사람 아래 섞지 않는다. 퇴직했거나 퇴직 예정인 레코드는 다시 쓰지 않는다 — 퇴직 뒤
      // 다시 입사하면 옛 레코드 · 계약과 상관없이 새 레코드에 새 근로계약서를 발행한다(2026-10-19 김민식, api #65 리뷰).
      // 재계약(연장)이면 직전 계약의 레코드를 쓴다 — 같은 사람이라 이름이 달라도(고쳐 적음) 그 레코드다.
      const reusable =
        sameRecord ??
        (await tx.staffMember.findFirst({
          where: {
            storeId: dto.storeId,
            phone: dto.phone,
            name: dto.name,
            joinStatus: { not: 'JOINED' },
            employmentStatus: 'EMPLOYED',
            retiredDate: null,
          },
          select: {
            staffMemberId: true,
            joinStatus: true,
            candidateAccountId: true,
          },
          orderBy: { staffMemberId: 'desc' },
        }));
      if (reusable) {
        const { staffMemberId, joinStatus, candidateAccountId } = reusable;
        // 가입한 직원 레코드는 이름 · 번호가 계정 값이라 덮어쓰지 않는다 — 직무 · 고용 형태만 계약을 따른다(이어 쓰기와 같다)
        await tx.staffMember.update({
          where: { staffMemberId },
          data: joined
            ? { employmentType: dto.employmentType, jobTitle: dto.jobTitle }
            : {
                ...staffMemberFields(dto),
                candidateAccountId: invite.candidateAccountId,
                // 퇴직 뒤 다시 입사한 사람이면 옛 레코드를 잇는다(WHALEERP-615)
                previousStaffMemberId: await previousRecordOf(
                  tx,
                  dto,
                  staffMemberId,
                ),
              },
        });
        const { contractId } = await tx.contract.create({
          data: { ...contract, staffMemberId },
          select: { contractId: true },
        });
        await saveDocuments(contractId);
        // 종이 계약 등록은 곧바로 체결 완료라 빈 입사일을 채운다 — 다시 쓰는 레코드에 입사일이 있으면 그대로(WHALEERP-613)
        if (status === 'SIGNED')
          await fillHiredDate(tx, staffMemberId, fields.startDate);
        await dropOrphanRecords(
          tx,
          replaced.map((r) => r.staffMemberId),
          staffMemberId,
        );
        const pending = await deliver(contractId, staffMemberId, {
          joinStatus,
          candidateAccountId,
        });
        return {
          result: {
            contractId,
            staffMemberId,
            status,
            draftAction: sentActionOf(sends, joined, invite.draftAction),
          },
          pending,
        };
      }

      const created = await tx.staffMember.create({
        data: {
          ...staffMemberFields(dto),
          joinStatus: 'DRAFT',
          candidateAccountId: invite.candidateAccountId,
          // 퇴직 뒤 다시 입사한 사람이면 옛 레코드를 잇는다(WHALEERP-615)
          previousStaffMemberId: await previousRecordOf(tx, dto),
          contracts: { create: contract },
        },
        select: {
          staffMemberId: true,
          contracts: { select: { contractId: true } },
        },
      });
      await saveDocuments(created.contracts[0].contractId);
      if (status === 'SIGNED')
        await fillHiredDate(tx, created.staffMemberId, fields.startDate);
      // 이름이 달라 새 레코드를 만들었어도, 대체로 계약을 잃은 옛 가입 전 레코드는 지운다 — 남기면 직원 목록에
      // 「재직 · 계약 없음」 레코드가 보인다.
      await dropOrphanRecords(
        tx,
        replaced.map((r) => r.staffMemberId),
        created.staffMemberId,
      );
      const contractId = created.contracts[0].contractId;
      const pending = await deliver(contractId, created.staffMemberId, {
        joinStatus: 'DRAFT',
        candidateAccountId: null,
      });
      return {
        result: {
          contractId,
          staffMemberId: created.staffMemberId,
          status,
          draftAction: sentActionOf(sends, false, invite.draftAction),
        },
        pending,
      };
    });
    const sent = await this.delivery.dispatch(pending, adminAccountId);
    return this.settledResult(result, sent);
  }

  /**
   * 커밋 뒤 보내기(dispatch)를 마친 저장 응답. dispatch 가 보내지 않았으면(그사이 다른 요청 — 발송 대기 종료 · 재발송 — 이 초대를
   * 무효로 했다, false) 지금 상태를 싣고 처리 결과는 null 로 둔다 — 보냈다고 알리지 않게(api #146 리뷰). 보냈거나 보낼 것이 없으면
   * 그대로다(다시 읽지 않는다). 지금 상태를 읽다 실패하면 저장은 이미 끝났으니 오류로 답하지 않는다 — 500 이면 화면이 저장 실패로
   * 알고 다시 저장한다. 계산한 상태에 처리 결과 null 을 싣고 로그만 남긴다.
   */
  private async settledResult(
    result: CreatedContractResponseDto,
    sent: boolean,
  ): Promise<CreatedContractResponseDto> {
    if (sent) return result;
    const now = await this.prisma.contract
      .findUnique({
        where: { contractId: result.contractId },
        select: { status: true },
      })
      .catch((e: unknown) => {
        this.logger.error(
          `보내지 않은 저장의 지금 상태를 읽지 못함 contract=${result.contractId}`,
          e instanceof Error ? e.stack : String(e),
        );
        return null;
      });
    // 지금 상태를 모르면 계산한 상태로 답하지 않는다 — 그사이 종료됐는데 서명 대기로 알릴 수 있다. 되돌리기 실패처럼 502
    // SEND_UNCONFIRMED 로 답해 화면이 상세를 다시 읽게 한다(저장은 끝났다 — 다시 저장하지 않게, api #146 재리뷰)
    if (!now?.status)
      throw new BadGatewayException({
        statusCode: HttpStatus.BAD_GATEWAY,
        error: 'Bad Gateway',
        code: 'SEND_UNCONFIRMED',
        retryable: false,
        contractId: result.contractId,
        message:
          '저장했지만 가입 초대가 나갔는지 확인하지 못했습니다. 상세를 다시 열어 상태를 확인해 주세요',
      });
    return { ...result, status: now.status, draftAction: null };
  }

  /**
   * 근로계약 상세 — 작성 화면을 다시 채울 값(임시저장 이어 쓰기)과 상세 화면이 보이는 발송 · 처리 정보(WHALEERP-328):
   * 처음 · 마지막 발송 일시, 날인 기한, 최종 처리일, 거부 사유, 재발송 횟수, 직전 계약, 종이 계약의 등록일 · 등록 관리자.
   */
  async findOne(
    adminAccountId: number,
    contractId: number,
  ): Promise<ContractDetailDto> {
    const c = await this.prisma.contract.findUnique({
      where: { contractId },
      select: {
        contractId: true,
        staffMemberId: true,
        storeId: true,
        status: true,
        contractMethod: true,
        ...CONTRACT_TERMS_SELECT,
        draftAction: true,
        sentAt: true,
        signDeadlineAt: true,
        rejectReason: true,
        resendCount: true,
        previousContractId: true,
        createdAt: true,
        createdBy: true,
        // 최근 것부터. 같은 시각(초안 저장과 자동 발송이 한 번에)이면 나중에 쓴 줄이 먼저다.
        contractStatusHistories: {
          orderBy: [{ changedAt: 'desc' }, { contractStatusHistoryId: 'desc' }],
          select: {
            fromStatus: true,
            toStatus: true,
            actor: true,
            changedAt: true,
          },
        },
        staffMember: {
          select: {
            name: true,
            phone: true,
            jobTitle: true,
            employmentType: true,
            joinStatus: true,
            ...HQ_SHARING_SELECT,
          },
        },
        contractParty: {
          select: {
            enteredName: true,
            enteredPhone: true,
            enteredBirthDate: true,
            enteredGender: true,
            isForeigner: true,
          },
        },
      },
    });
    if (!c) throw new NotFoundException(CONTRACT_NOT_FOUND);
    await this.checkContractScope(adminAccountId, c);
    // stores 는 1팀 테이블이라 Prisma 관계가 없다. 이름만 따로 읽는다(지운 점포여도 이름은 보인다).
    const store = await this.prisma.store.findUnique({
      where: { storeId: c.storeId },
      select: { name: true },
    });
    // 종이 계약 날인본. 관계를 함께 읽으면 Prisma 가 쿼리를 동시에 보내 PGlite(e2e)가 연결을 끊어 따로 읽는다.
    // 직원 앱 날인의 필기 서명(SIGNATURE)은 처리 완료본(WHALEERP-131)에 합성할 재료라 관리자에게 보이지 않는다(WHALEERP-145)
    const documents = await this.prisma.contractDocument.findMany({
      where: { contractId, kind: { not: 'SIGNATURE' } },
      select: { contractDocumentId: true, kind: true, fileName: true },
      orderBy: { contractDocumentId: 'asc' },
    });
    const birth = c.contractParty?.enteredBirthDate;
    const paper = c.contractMethod === 'PAPER';
    // 종이 계약 등록일 — 체결 완료가 된 때(임시저장해 두었다가 등록할 수 있어 만든 때가 아니다). 등록 전 임시저장 · 등록 전에
    // 대체 · 퇴직으로 종료된 임시저장은 null. 이력이 아예 없는 옛 체결 완료 · 종료 계약만 만든 때로 채운다
    const registered = !paper
      ? null
      : (c.contractStatusHistories.findLast((h) => h.toStatus === 'SIGNED')
          ?.changedAt ??
        (c.contractStatusHistories.length === 0 &&
        (c.status === 'SIGNED' || c.status === 'ENDED')
          ? c.createdAt
          : null));
    // admin_accounts 는 1팀 테이블이라 Prisma 관계가 없다 — 등록한 종이 계약일 때만 작성한 관리자 이름을 따로 읽는다
    const registrar = registered
      ? await this.prisma.adminAccount.findUnique({
          where: { adminAccountId: c.createdBy },
          select: { name: true, loginId: true },
        })
      : null;
    // 처음 보낸 때 — 이력은 최근 것부터라 발송 대기 · 서명 대기로 간 줄 가운데 마지막 것이 처음이다
    const firstSent = c.contractStatusHistories.findLast(
      (h) =>
        h.toStatus === 'PENDING_SEND' || h.toStatus === 'PENDING_SIGNATURE',
    );
    const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
    // 재발송할 수 있는가 — 재발송(ContractSendService.send)과 같은 판정: 발송 대기 · 서명 대기이고, 가입한 직원(앱 알림)이거나
    // 그 번호로 계정이 없는 가입 전 직원(가입 초대). 계정이 있는 번호(소속 추가 확인 · 복귀 확인)는 409 라 버튼을 숨긴다
    const canResend =
      !!c.status &&
      RESENDABLE_STATUSES.includes(c.status) &&
      (c.staffMember.joinStatus === 'JOINED' ||
        (await accountOfPhone(this.prisma, c.staffMember.phone)) === null);
    return {
      contractId: c.contractId,
      staffMemberId: c.staffMemberId,
      status: c.status,
      // 이름 · 번호는 계약서 값(관리자가 넣은 당사자 값)이다 — 본인 대조에 쓰는 값이라 가입한 직원이어도 계약서
      // 값을 보인다(직원 레코드는 계정 값). 당사자 행이 없는 옛 계약만 직원 레코드 값으로 채운다.
      name: c.contractParty?.enteredName ?? c.staffMember.name,
      phone: c.contractParty?.enteredPhone ?? c.staffMember.phone,
      jobTitle: c.staffMember.jobTitle,
      // 고용 형태는 직원 레코드가 원본이다(계약 칸은 그 사본).
      employmentType: c.staffMember.employmentType,
      storeId: c.storeId,
      storeName: store?.name ?? null,
      birthDate: birth ? isoDate(birth) : null,
      gender: c.contractParty?.enteredGender ?? null,
      isForeigner: c.contractParty?.isForeigner ?? false,
      contractMethod: c.contractMethod,
      ...contractTermsOf(c),
      documents,
      draftAction: c.draftAction,
      histories: c.contractStatusHistories.map((h) => ({
        fromStatus: h.fromStatus,
        toStatus: h.toStatus,
        actor: h.actor,
        changedAt: h.changedAt.toISOString(),
      })),
      firstSentAt: iso(firstSent?.changedAt),
      lastSentAt: iso(c.sentAt),
      signDeadlineAt: iso(c.signDeadlineAt),
      lastProcessedAt: iso(c.contractStatusHistories[0]?.changedAt),
      rejectReason: c.status === 'REJECTED' ? c.rejectReason : null,
      resendCount: c.resendCount ?? 0,
      previousContractId: c.previousContractId,
      registeredAt: iso(registered),
      registeredBy: registrar ? (registrar.name ?? registrar.loginId) : null,
      canResend,
    };
  }

  /**
   * 임시저장 이어 쓰기. 폼 전체를 다시 받아 덮어쓴다. 임시저장(DRAFT)일 때만 고칠 수 있고, 초안 저장으로
   * 넘기면(isTemporarySave 없음) 발송 대기가 되며 상태 이력을 남긴다. 한 트랜잭션이라 중간에 실패하면 그대로다.
   */
  async update(
    adminAccountId: number,
    contractId: number,
    dto: CreateContractDto,
    documents: readonly PaperDocument[] = [],
  ): Promise<CreatedContractResponseDto> {
    checkInput(dto);
    checkPaper(dto, documents);
    const fields = contractFields(dto);
    // 지금 근무지도, 옮겨 갈 근무지도 업무 범위 안이어야 한다. 지금 근무지는 계약 직원의 동의로 봤으니, 같은
    // 근무지면 점포 단위로 다시 묻지 않는다 — 동의한 가맹 점포 직원의 임시저장을 본사 역할이 이어 쓸 수 있게.
    // 점포가 남아 있는지(폐점 · 삭제)는 같은 근무지여도 늘 본다 — 임시저장 뒤 폐점한 점포로 발송 대기가 되지 않게.
    const scoped = await this.scopedContractOf(adminAccountId, contractId);
    const scopedStore = scoped.storeId;
    if (dto.storeId !== scopedStore)
      await this.checkStore(adminAccountId, dto.storeId);
    else await this.checkStoreOpen(dto.storeId);
    // 점포 단위 범위가 있는가 — 없으면 이 계약 직원의 동의로만 보는 관리자(본사 역할)다. 근무지를 옮기면 위에서 이미 봤다.
    // 동의로만 보는 관리자는 번호를 바꿀 수 없고, 같은 점포 · 같은 번호의 다른 직원 레코드 계약을 대체할 수도 없다 — 그
    // 계약(동의하지 않은 직원 것)이 409 에 이름 · 기간과 함께 실리고 대체로 닫힐 수 있어서다(api #49 4차 · 5차 리뷰).
    const storeLevel =
      dto.storeId !== scopedStore ||
      (await this.scope.canManageStaffAt(adminAccountId, dto.storeId, false));
    // 연 뒤 다른 요청이 번호를 바꿨어도 여기서는 「바꿈」으로 보여 같은 403 이다 — 문구가 두 경우를 아우른다(5차 참고 3).
    if (!storeLevel && dto.phone !== scoped.phone)
      throw new ForbiddenException(PHONE_CHANGE_FORBIDDEN);
    const now = new Date();

    const { result, pending } = await this.withDocuments<{
      result: CreatedContractResponseDto;
      pending: PendingInvite | null;
    }>(documents, async (tx, saveDocuments) => {
      // 지금 번호와 새 번호를 둘 다 잠근다. 새 번호로만 잠그면, 번호를 바꾸는 사이 지금 번호로 저장하는 다른 요청이
      // 이 계약을 대체해 당사자 · 근무일이 지워진 계약이 남는다.
      const before = await tx.contract.findUnique({
        where: { contractId },
        select: {
          staffMemberId: true,
          staffMember: { select: { phone: true } },
        },
      });
      if (!before) throw new NotFoundException(CONTRACT_NOT_FOUND);
      // 범위를 본 뒤 다른 요청이 번호를 바꿨으면 위 번호 변경 검사가 맞지 않는다 — 다시 열게 한다.
      if (before.staffMember.phone !== scoped.phone)
        throw new ConflictException(
          '다른 요청이 먼저 근로계약을 고쳤습니다. 다시 열어 주세요',
        );
      await lockPeople(tx, [before.staffMember.phone, dto.phone]);
      // 직원 행을 계약 행보다 먼저 잠근다 — 아래에서 직원 행(직무 · 고용 형태)을 쓴다. 퇴직 확정 · 직원 앱 날인 · 거부 ·
      // 수정 요청이 직원 행 → 계약 행 순서라, 계약 행을 먼저 잡고 직원 행을 쓰면 교착(40P01, 500)이 된다(api #104).
      // 대체할 수 있는 다른 직원 행도 자기 것과 함께 id 순으로 — 자기 것을 쥔 채 대체 대상을 잡으면 직원 id 순으로 잡는
      // 하루 배치와 엇갈린다(api #150 리뷰).
      await lockStaffForReplace(
        tx,
        dto.storeId,
        dto.phone,
        before.staffMemberId,
      );
      await lockContract(tx, contractId);
      const current = await tx.contract.findUnique({
        where: { contractId },
        select: {
          status: true,
          staffMemberId: true,
          storeId: true,
          draftAction: true,
          sentAt: true,
          signDeadlineAt: true,
          previousContractId: true,
          staffMember: {
            select: {
              phone: true,
              joinStatus: true,
              candidateAccountId: true,
              retiredDate: true,
            },
          },
        },
      });
      if (!current) throw new NotFoundException(CONTRACT_NOT_FOUND);
      sameStore(current.storeId, scopedStore);
      const joined = current.staffMember.joinStatus === 'JOINED';
      // 잠근 직원이 쓸 직원이어야 한다 — 계약의 직원 레코드는 만들 때만 정해지지만, 바뀌면 잠그지 않은 행을 쓰게 된다
      if (
        current.staffMemberId !== before.staffMemberId ||
        current.staffMember.phone !== before.staffMember.phone
      )
        throw new ConflictException(
          '다른 요청이 먼저 근로계약을 고쳤습니다. 다시 열어 주세요',
        );
      // 임시저장과, 직원이 수정을 요청한 계약(WHALEERP-125 · 126)을 고칠 수 있다. 수정 요청은 고쳐 저장하면 곧바로 다시
      // 보낸다(2026-10-19 재영) — 임시저장으로 되돌리거나 종이 계약으로 바꿔 체결 완료로 넘기지는 않는다.
      if (current.status === 'CORRECTION_REQUESTED') {
        if (fields.status !== 'PENDING_SEND')
          throw new BadRequestException(
            '수정 요청 근로계약서는 고쳐 저장하면 곧바로 다시 보냅니다 — 임시저장 · 종이 계약 등록은 할 수 없습니다',
          );
        // 이미 보낸 계약이라 근무지는 그대로다 — 옮기려면 새 계약으로 대체한다(api #58 리뷰)
        if (dto.storeId !== current.storeId)
          throw new BadRequestException(WORKPLACE_FIXED);
      } else if (current.status !== 'DRAFT')
        throw new ConflictException(EDITABLE_ONLY);
      // 재계약 임시저장(WHALEERP-156)은 직전 계약과 같은 근무지 · 번호여야 한다 — 바꾸면 직전 계약 링크가 다른 사람 · 점포의 계약을
      // 가리킨 채 남아, 체결 뒤 하루 배치가 엉뚱한 계약을 닫고 연장한 레코드의 값이 바뀐다(api 재계약 리뷰). 저장 때 재직이던 가입한
      // 직원이 그사이 퇴직일을 정했으면 보내지 않는다 — 저장(POST)이었다면 409 다.
      if (current.previousContractId) {
        if (dto.storeId !== current.storeId)
          throw new BadRequestException(
            '재계약은 직전 계약과 같은 근무지로만 할 수 있습니다',
          );
        if (dto.phone !== current.staffMember.phone)
          throw new BadRequestException(
            '재계약은 직전 계약과 같은 휴대전화번호로만 할 수 있습니다',
          );
        if (joined && current.staffMember.retiredDate !== null)
          throw new ConflictException(
            '이 점포에 같은 번호로 재직 중인 직원이 있습니다',
          );
      }
      // 가드는 「작성 또는 수정」만 봤다 — 임시저장을 이어 써 보내는 것은 작성, 수정 요청을 고쳐 다시 보내는 것은 수정이다
      await requireContractAction(
        tx,
        adminAccountId,
        current.status === 'CORRECTION_REQUESTED' ? 'update' : 'create',
      );

      await checkNotEmployed(tx, dto, current.staffMemberId);
      // 재계약 임시저장을 종이 계약으로 등록해도 직전 계약은 대체하지 않는다 — 새 계약 시작일에 하루 배치가 닫는다(WHALEERP-156)
      const replaced = (
        await inProgressAtStore(
          tx,
          dto.storeId,
          dto.phone,
          contractId,
          fields.status === 'SIGNED',
        )
      ).filter((c) => c.contractId !== current.previousContractId);
      // 동의로만 보는 관리자에게는 이 계약 직원의 계약만 보이고 대체할 수 있다 — 같은 점포 · 번호의 다른 레코드는 (가입
      // 전이면 계정이 없어) 동의하지 않은 것으로 가려질 수 있다. 섞이면 409 로 이름을 보이기 전에 막는다(5차 참고 1 — 본사
      // 제공 동의 저장이 붙으면 실제로 생기는 경로).
      if (
        !storeLevel &&
        replaced.some((r) => r.staffMemberId !== current.staffMemberId)
      )
        throw new ForbiddenException(OTHER_RECORD_FORBIDDEN);
      await requireReplaceActions(tx, adminAccountId, replaced, ASK_DELETER);
      checkReplace(replaced, dto.replaceContractIds);
      await replaceContracts(tx, replaced, dto);
      await dropOrphanRecords(
        tx,
        replaced.map((r) => r.staffMemberId),
        current.staffMemberId,
      );
      if (fields.status !== 'DRAFT') await checkWorkTimeOverlap(tx, dto);

      // 가입한 직원의 번호는 계정의 신원 기준이라 바꾸지 않는다(WHALEERP-125, 2026-10-16)
      if (joined && dto.phone !== current.staffMember.phone)
        throw new BadRequestException(JOINED_PHONE_FIXED);
      // 수정 요청은 이미 보낸 계약이라 번호가 그대로면 초대 유형을 다시 판별하지 않는다 — 가입한 직원은 자기 레코드가
      // 재직이라 판별이 늘 「이미 재직 중」이 된다(재직은 계약서를 받을 때부터, WHALEERP-125 「재직과 매장 정보」).
      // 번호가 바뀌면(가입 전 직원만 — 가입한 직원은 위에서 400) 근로자 정보 수정처럼 새 번호로 다시 판별한다(api #58 재리뷰).
      // 가입한 직원의 재계약 임시저장(WHALEERP-156)을 이어 쓸 때도 같다 — 판별하지 않고 앱으로 받는다.
      const invite: Invitation =
        fields.status === 'DRAFT'
          ? NOT_YET
          : ((joined && current.previousContractId) ||
                current.status === 'CORRECTION_REQUESTED') &&
              dto.phone === current.staffMember.phone
            ? {
                draftAction: current.draftAction as Invitation['draftAction'],
                candidateAccountId: current.staffMember.candidateAccountId,
              }
            : await decideInvitation(tx, dto.storeId, dto.phone);

      const { status: saved, ...terms } = fields;
      const data = { ...terms, draftAction: invite.draftAction };
      // 초안 저장(전자계약)은 곧바로 보낸다 — 보낸 뒤의 상태로 넘긴다(가입 초대 발송 대기 · 앱으로 받으면 서명 대기)
      const sends = saved === 'PENDING_SEND';
      const status = sends
        ? deliveredStatusOf(joined, invite.draftAction)
        : saved;
      if (status === 'DRAFT') {
        // 읽은 뒤 다른 요청이 먼저 넘겼으면(상태가 바뀌었으면) 0건이다. 그때는 아무것도 쓰지 않는다.
        const { count } = await tx.contract.updateMany({
          where: { contractId, status: 'DRAFT' },
          data: { ...data, status },
        });
        if (count === 0) throw new ConflictException(EDITABLE_ONLY);
      } else
        // 초안 저장(보냄) · 종이 계약 등록(체결 완료)으로 넘긴다 — 상태 전환(contract-status)이 읽은 상태
        // (임시저장 · 수정 요청)일 때만 바꾸고 상태 이력을 남긴다. 서명 기한은 보낼 때(prepare) 새로 잡는다.
        await transition(tx, contractId, status, 'ADMIN', {
          from: [current.status],
          data,
        });
      await saveDocuments(contractId);
      // 임시저장을 종이 계약으로 등록하면 체결 완료다 — 직원 행은 위에서 write 로 잠갔다(WHALEERP-613)
      if (status === 'SIGNED')
        await fillHiredDate(tx, current.staffMemberId, fields.startDate);

      // 가입한 직원 레코드는 이름 · 번호가 계정 값이라 덮어쓰지 않는다 — 계약 쪽(당사자) 값만 고친다(근로자 정보 수정과
      // 같은 규칙). 직무 · 고용 형태는 계약이 정하므로 따라간다.
      await tx.staffMember.update({
        where: { staffMemberId: current.staffMemberId },
        data: joined
          ? {
              employmentType: dto.employmentType,
              jobTitle: dto.jobTitle,
            }
          : {
              ...staffMemberFields(dto),
              candidateAccountId: invite.candidateAccountId,
              // 이름 · 번호가 바뀌었을 수 있어 이을 옛 레코드를 다시 찾는다(WHALEERP-615). 퇴직(예정) 레코드는 그 자신이
              // 지난 재직 기간이라 다시 잇지 않는다 — 나중 재직 기간을 앞으로 이어 사슬이 돌 수 있다.
              ...(!current.staffMember.retiredDate && {
                previousStaffMemberId: await previousRecordOf(
                  tx,
                  dto,
                  current.staffMemberId,
                ),
              }),
            },
      });
      await tx.contractParty.upsert({
        where: { contractId },
        update: partyFields(dto),
        create: { contractId, ...partyFields(dto) },
      });
      await tx.contractWorkDay.deleteMany({ where: { contractId } });
      const rows = workDayRows(dto);
      if (rows.length)
        await tx.contractWorkDay.createMany({
          data: rows.map((r) => ({ contractId, ...r })),
        });
      const pending = sends
        ? await this.delivery.prepare(
            tx,
            {
              contractId,
              storeId: dto.storeId,
              phone: dto.phone,
              joined,
              draftAction: invite.draftAction,
              before: {
                status: current.status,
                sentAt: current.sentAt,
                signDeadlineAt: current.signDeadlineAt,
                draftAction: current.draftAction,
                staffMemberId: current.staffMemberId,
                staffMember: current.staffMember,
              },
              statusChanged: true,
              phoneChanged: dto.phone !== current.staffMember.phone,
              replacedContracts: replaced.length > 0,
            },
            now,
          )
        : null;
      return {
        result: {
          contractId,
          staffMemberId: current.staffMemberId,
          status,
          draftAction: sentActionOf(sends, joined, invite.draftAction),
        },
        pending,
      };
    });
    const sent = await this.delivery.dispatch(pending, adminAccountId);
    return this.settledResult(result, sent);
  }

  /**
   * 날인 전 당사자 정보 수정(WHALEERP-125 「본인 대조」 · 126, CTR-28). 발송 대기 · 서명 대기 · 수정 요청 계약의
   * 이름 · 휴대전화번호 · 생년월일 · 성별 · 외국인 여부를 고친다 — 링크를 받지 못했다는 직원과 유선으로 확인한 뒤
   * 번호를 바로잡거나, 직원이 대조에 실패해 수정을 요청했을 때 쓴다.
   * - 저장하면 곧바로 다시 보낸다(2026-10-19 재영) — 새 서명 기한(30일), 앞서 나간 링크는 무효. 가입 초대면 발송 대기,
   *   앱으로 받는 직원이면 서명 대기다(수정 요청도 서명 대기로).
   * - 번호가 바뀌면 새 번호로 재직 확인 · 같은 점포 진행 중 계약(대체 확인) · 다른 점포 근무 시간 겹침 · 초대 유형 판별을
   *   다시 한다. 번호를 바꾸려면 점포 단위 범위가 있어야 한다(이어 쓰기와 같은 규칙).
   * - 가입한 직원 레코드(가입 완료)는 계정 값이라 레코드는 두고 계약 당사자 값만 고친다.
   */
  async updateWorker(
    adminAccountId: number,
    contractId: number,
    dto: UpdateWorkerDto,
  ): Promise<CreatedContractResponseDto> {
    const scoped = await this.scopedContractOf(adminAccountId, contractId);
    const storeLevel = await this.scope.canManageStaffAt(
      adminAccountId,
      scoped.storeId,
      false,
    );
    if (!storeLevel && dto.phone !== scoped.phone)
      throw new ForbiddenException(PHONE_CHANGE_FORBIDDEN);
    const now = new Date();

    const { result, pending } = await this.withDocuments<{
      result: CreatedContractResponseDto;
      pending: PendingInvite | null;
    }>([], async (tx) => {
      const before = await tx.contract.findUnique({
        where: { contractId },
        select: {
          staffMemberId: true,
          storeId: true,
          staffMember: { select: { phone: true } },
        },
      });
      if (!before) throw new NotFoundException(CONTRACT_NOT_FOUND);
      if (before.staffMember.phone !== scoped.phone)
        throw new ConflictException(
          '다른 요청이 먼저 근로계약을 고쳤습니다. 다시 열어 주세요',
        );
      await lockPeople(tx, [before.staffMember.phone, dto.phone]);
      // 직원 행(write) → 계약 행. 번호를 바꾸면 새 번호의 같은 점포 계약을 대체하므로 그 직원 행도 자기 것과 함께 id 순으로
      // 먼저 잡는다(api #150 리뷰 — 하루 배치와의 교착). 계약의 직원 · 근무지는 번호를 잡은 뒤로 바뀌지 않는다.
      await lockStaffForReplace(
        tx,
        before.storeId,
        dto.phone,
        before.staffMemberId,
      );
      await lockContract(tx, contractId);
      const current = await tx.contract.findUnique({
        where: { contractId },
        select: {
          status: true,
          storeId: true,
          staffMemberId: true,
          startDate: true,
          endDate: true,
          draftAction: true,
          sentAt: true,
          signDeadlineAt: true,
          staffMember: {
            select: {
              phone: true,
              joinStatus: true,
              candidateAccountId: true,
              retiredDate: true,
            },
          },
          contractWorkDays: {
            select: { weekday: true, startTime: true, endTime: true },
          },
        },
      });
      if (!current) throw new NotFoundException(CONTRACT_NOT_FOUND);
      sameStore(current.storeId, scoped.storeId);
      if (current.staffMember.phone !== before.staffMember.phone)
        throw new ConflictException(
          '다른 요청이 먼저 근로계약을 고쳤습니다. 다시 열어 주세요',
        );
      if (!current.status || !WORKER_EDITABLE.includes(current.status))
        throw statusConflict(current.status ?? 'PENDING_SEND');

      // 검사들이 받는 모양(계약서 본문)으로 — 근무지 · 기간 · 근무 요일은 지금 계약 값
      const input = {
        ...dto,
        storeId: current.storeId,
        startDate: current.startDate ? isoDate(current.startDate) : undefined,
        endDate: current.endDate ? isoDate(current.endDate) : undefined,
        workDays: current.contractWorkDays.map((d) => ({
          weekday: d.weekday,
          startTime: hhmm(d.startTime),
          endTime: hhmm(d.endTime),
        })),
      } as CreateContractDto;
      // 운영 정책 ACC-22 — 계약 시작일 기준 만 19세 미만이면 받지 않는다(초안 저장과 같은 문장)
      if (
        input.birthDate &&
        input.startDate &&
        ageOn(input.birthDate, input.startDate) < 19
      )
        throw new BadRequestException(
          '만 19세 미만 직원은 등록할 수 없습니다 (계약 시작일 기준)',
        );

      const phoneChanged = dto.phone !== current.staffMember.phone;
      if (phoneChanged && current.staffMember.joinStatus === 'JOINED')
        throw new BadRequestException(JOINED_PHONE_FIXED);
      const joined = current.staffMember.joinStatus === 'JOINED';
      let draftAction = current.draftAction as Invitation['draftAction'];
      let candidateAccountId: number | null | undefined;
      let replacedContracts = false;
      if (phoneChanged) {
        await checkNotEmployed(tx, input, current.staffMemberId);
        const replaced = await inProgressAtStore(
          tx,
          current.storeId,
          dto.phone,
          contractId,
        );
        await requireReplaceActions(tx, adminAccountId, replaced, ASK_DELETER);
        checkReplace(replaced, dto.replaceContractIds);
        await replaceContracts(tx, replaced, {
          storeId: current.storeId,
          phone: dto.phone,
        });
        replacedContracts = replaced.length > 0;
        await dropOrphanRecords(
          tx,
          replaced.map((r) => r.staffMemberId),
          current.staffMemberId,
        );
        await checkWorkTimeOverlap(tx, input);
        const invite = await decideInvitation(tx, current.storeId, dto.phone);
        draftAction = invite.draftAction;
        candidateAccountId = invite.candidateAccountId;
      }

      // 다시 보낸 뒤의 상태 — 상태가 바뀌면 전환(이력), 그대로면 기한 · 초대만 새로(prepare)
      const status = deliveredStatusOf(joined, draftAction);
      const statusChanged = status !== current.status;
      if (statusChanged)
        await transition(tx, contractId, status, 'ADMIN', {
          from: [current.status],
        });

      await tx.contractParty.upsert({
        where: { contractId },
        update: partyFields(input),
        create: { contractId, ...partyFields(input) },
      });
      if (current.staffMember.joinStatus !== 'JOINED')
        await tx.staffMember.update({
          where: { staffMemberId: current.staffMemberId },
          data: {
            name: dto.name,
            phone: dto.phone,
            ...(phoneChanged && { candidateAccountId }),
            // 이름 · 번호를 바로잡으면 이을 옛 레코드를 다시 찾는다(WHALEERP-615) — 퇴직(예정) 레코드는 이어 쓰기와 같이 둔다
            ...(!current.staffMember.retiredDate && {
              previousStaffMemberId: await previousRecordOf(
                tx,
                { storeId: current.storeId, name: dto.name, phone: dto.phone },
                current.staffMemberId,
              ),
            }),
          },
        });
      const pending = await this.delivery.prepare(
        tx,
        {
          contractId,
          storeId: current.storeId,
          phone: dto.phone,
          joined,
          draftAction,
          before: {
            status: current.status,
            sentAt: current.sentAt,
            signDeadlineAt: current.signDeadlineAt,
            draftAction: current.draftAction,
            staffMemberId: current.staffMemberId,
            staffMember: current.staffMember,
          },
          statusChanged,
          phoneChanged,
          replacedContracts,
        },
        now,
      );
      return {
        result: {
          contractId,
          staffMemberId: current.staffMemberId,
          status,
          draftAction: sentActionOf(true, joined, draftAction),
        },
        pending,
      };
    });
    const sent = await this.delivery.dispatch(pending, adminAccountId);
    return this.settledResult(result, sent);
  }

  /**
   * 임시저장 삭제. 발송한 적이 없어 남길 기록이 없다고 보고 행을 지운다(2026-10-12 결정) — 근무 요일 · 당사자 ·
   * 상태 이력 · 계약, 그리고 그 계약에만 쓰인 초안(가입 전) 직원 레코드. 임시저장이 아니면 409.
   * 계약 삭제는 상태를 조건으로 걸어, 읽은 뒤 초안 저장으로 넘어갔으면 0건 → 409 로 트랜잭션째 되돌린다.
   */
  async remove(adminAccountId: number, contractId: number): Promise<void> {
    const scopedStore = await this.scopedStoreOf(adminAccountId, contractId);
    await this.prisma.$transaction(async (tx) => {
      await lockContractWithStaff(tx, contractId);
      const current = await tx.contract.findUnique({
        where: { contractId },
        select: { status: true, staffMemberId: true, storeId: true },
      });
      if (!current) throw new NotFoundException(CONTRACT_NOT_FOUND);
      sameStore(current.storeId, scopedStore);
      if (current.status !== 'DRAFT')
        throw new ConflictException('임시저장한 근로계약서만 지울 수 있습니다');

      await tx.contractWorkDay.deleteMany({ where: { contractId } });
      await tx.contractParty.deleteMany({ where: { contractId } });
      await tx.contractStatusHistory.deleteMany({ where: { contractId } });
      const { count } = await tx.contract.deleteMany({
        where: { contractId, status: 'DRAFT' },
      });
      if (count === 0)
        throw new ConflictException('임시저장한 근로계약서만 지울 수 있습니다');

      const others = await tx.contract.count({
        where: { staffMemberId: current.staffMemberId },
      });
      if (others === 0) {
        const draft = {
          staffMemberId: current.staffMemberId,
          joinStatus: 'DRAFT',
        } satisfies Prisma.StaffMemberWhereInput;
        // 지울 레코드를 이전 재직 레코드로 가리키는 연결은 끊는다(WHALEERP-615, 외래키 RESTRICT) — dropOrphanRecords 와 같다
        await tx.staffMember.updateMany({
          where: { previousStaffMember: draft },
          data: { previousStaffMemberId: null },
        });
        await tx.staffMember.deleteMany({ where: draft });
      }
    });
  }

  /**
   * 종이 계약 날인본 내려받기 주소. 계약 상세와 같은 업무 범위를 본 뒤 300초짜리 서명 주소를 준다 — 받으면 원래
   * 파일 이름으로 저장된다. 다른 계약의 파일 ID 로는 받지 못한다(404).
   */
  async documentDownloadUrl(
    adminAccountId: number,
    contractId: number,
    contractDocumentId: number,
  ): Promise<DownloadUrlResponseDto> {
    // 없는 계약 · 범위 밖 · 다른 계약의 파일은 저장소 설정과 상관없이 404 다 — 저장소 확인은 그 뒤에 한다.
    await this.scopedStoreOf(adminAccountId, contractId);
    const document = await this.prisma.contractDocument.findFirst({
      // 필기 서명은 상세 목록에 없으므로 받지도 못한다 — 없는 파일과 같은 404
      where: { contractDocumentId, contractId, kind: { not: 'SIGNATURE' } },
      select: { storageKey: true, fileName: true },
    });
    if (!document) throw new NotFoundException('파일을 찾을 수 없습니다');
    const storage = requireStorage(this.storage);
    return {
      url: await storage.downloadUrl(document.storageKey, document.fileName),
    };
  }

  /** 목록. 업무 범위 안 점포의 계약만이다. 사용 중인 관리자 계정이 아니면 403. */
  async list(
    adminAccountId: number,
    query: ListContractsQueryDto,
  ): Promise<ContractListResponseDto> {
    const { page, pageSize, status, storeName, staffMemberName } = query;

    const manageable = await this.scope.getManageableStores(adminAccountId);
    if (!manageable) throw new ForbiddenException(ACCOUNT_UNAVAILABLE_MESSAGE);
    // 고른 점포 · 점포 유형은 업무 범위 안에서만 거른다 — 범위 밖 id 는 조용히 빠진다(WHALEERP-326)
    const picked = query.storeIds?.length ? new Set(query.storeIds) : null;
    const types = query.storeTypes?.length
      ? new Set<string>(query.storeTypes)
      : null;
    let storeIds = manageable.stores
      .filter(
        (s) =>
          (!picked || picked.has(s.storeId)) &&
          (!types || types.has(s.storeTypeCode)),
      )
      .map((s) => s.storeId);
    // stores 는 1팀 테이블이라 Prisma 관계가 없다. 이름에 맞는 점포 id 를 먼저 구한다.
    if (storeName) {
      const stores = await this.prisma.store.findMany({
        where: {
          storeId: { in: storeIds },
          name: { contains: storeName, mode: 'insensitive' },
        },
        select: { storeId: true },
      });
      storeIds = stores.map((s) => s.storeId);
    }
    if (storeIds.length === 0)
      return { items: [], total: 0, statusCounts: zeroStatusCounts() };

    // 점포 단위로 가려지는 점포(본사 역할 × 직영 아님)의 계약은 본사 제공 동의한 직원 것만이다. 이름 · 상태
    // 조건은 이 조건과 함께(AND) 걸린다.
    const hidden = new Set(
      manageable.stores
        .filter((s) =>
          hidesPersonalData(manageable.roleTypeCode, s.storeTypeCode, false),
        )
        .map((s) => s.storeId),
    );
    const visibleIds = storeIds.filter((id) => !hidden.has(id));
    const hiddenIds = storeIds.filter((id) => hidden.has(id));
    const shown: Prisma.ContractWhereInput =
      hiddenIds.length === 0
        ? { storeId: { in: visibleIds } }
        : {
            OR: [
              { storeId: { in: visibleIds } },
              {
                storeId: { in: hiddenIds },
                staffMember: HQ_SHARING_CONSENTED,
              },
            ],
          };
    const name: Prisma.ContractWhereInput | null = staffMemberName
      ? {
          staffMember: {
            name: { contains: staffMemberName, mode: 'insensitive' },
          },
        }
      : null;
    // shown 은 storeId 나 OR 만 쓰므로 이름(staffMember) · 상태 조건과 겹치지 않는다
    const where: Prisma.ContractWhereInput = {
      ...shown,
      ...(status?.length && { status: { in: status } }),
      ...name,
    };
    // 상태별 개수는 보이는 계약만 센다 — 목록과 같은 조건에서 상태 필터만 뺀다. 가린 계약(본사 제공 미동의)까지 세면 미동의 직원이
    // 한 명뿐인 가맹 점포로 좁혀 그 사람의 계약 상태가 드러난다(api #146 리뷰). ATT-30 이 점포 단위 개수를 허용하는지는 기획 확인
    // 대기 — 허용으로 정해지면 가린 계약도 센다
    const countWhere: Prisma.ContractWhereInput = { ...shown, ...name };

    const [rows, total, grouped] = await this.prisma.$transaction([
      this.prisma.contract.findMany({
        where,
        include: {
          staffMember: { select: LIST_STAFF_SELECT },
          // 이미 재계약한 계약(직전 계약 링크 기준)은 갱신 예정일을 내지 않는다 — 알림 배치(needsRenewal)는 같은 레코드의 다른 계약을
          // 봐서 기준이 조금 다르다(재계약이 체결 뒤 종료되면 목록은 비우고 알림은 다시 대상이 된다)
          contractsAsPrevious: {
            where: LIVE_RENEWAL,
            select: { contractId: true },
            take: 1,
          },
        },
        // 등록 시각이 같은 계약끼리 페이지를 넘나들지 않게 id 를 마지막에 둔다.
        orderBy: [{ createdAt: 'desc' }, { contractId: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.contract.count({ where }),
      this.prisma.contract.groupBy({
        by: ['status'],
        where: countWhere,
        _count: { _all: true },
        // 트랜잭션 배열 안의 groupBy 는 orderBy 가 없으면 타입이 맞지 않는다(Prisma).
        orderBy: { status: 'asc' },
      }),
    ]);
    const statusCounts = zeroStatusCounts();
    // 트랜잭션 배열 안에서는 groupBy 결과 타입이 _count 를 좁히지 못해 모양을 붙인다. 상태가 빈 옛 행은 세지 않는다
    for (const g of grouped as {
      status: ContractStatus | null;
      _count: { _all: number };
    }[])
      if (g.status) statusCounts[g.status] = g._count._all;
    if (rows.length === 0) return { items: [], total, statusCounts };

    const stores = await this.prisma.store.findMany({
      where: { storeId: { in: [...new Set(rows.map((r) => r.storeId))] } },
      select: { storeId: true, name: true },
    });
    const storeNames = new Map(stores.map((s) => [s.storeId, s.name]));

    return {
      total,
      statusCounts,
      items: rows.map((r) => ({
        contractId: r.contractId,
        staffMemberId: r.staffMemberId,
        staffMemberName: r.staffMember.name,
        storeId: r.storeId,
        storeName: storeNames.get(r.storeId) ?? null,
        employmentType: r.employmentType,
        contractMethod: r.contractMethod,
        startDate: r.startDate ? isoDate(r.startDate) : null,
        endDate: r.endDate ? isoDate(r.endDate) : null,
        wageAmount: r.wageAmount,
        status: r.status,
        draftAction: r.draftAction,
        sentAt: r.sentAt?.toISOString() ?? null,
        signDeadlineAt: r.signDeadlineAt?.toISOString() ?? null,
        staffJoinState: joinStateOf(
          r.staffMember.joinStatus,
          r.staffMember.invitations,
        ),
        staffRetired: r.staffMember.employmentStatus === 'RETIRED',
        renewalDate: r.contractsAsPrevious.length
          ? null
          : dateOnly(renewalDateOf(r)),
        previousContractId: r.previousContractId,
      })),
    };
  }
}
