import {
  BadRequestException,
  HttpStatus,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  decryptPersonalData,
  encryptPersonalData,
  staffTaxProfileAad,
} from '../common/personal-data-cipher';
import { PERSONAL_DATA_KEY } from '../common/personal-data-key.provider';
import { maskAccountNumber, maskRrn } from '../common/personal-data-mask';
import { verifyPassword } from '../auth/password';
import { PrismaService } from '../prisma/prisma.service';
import { ACTIVE_STAFF } from '../todos/todo-rules';
import { dateOnly } from '../common/date-only';
import type {
  MyMembershipListResponseDto,
  MyTaxProfileDto,
  MyTaxProfileResponseDto,
} from './dto/my-membership.response.dto';
import type { SaveMyTaxProfileDto } from './dto/save-my-tax-profile.dto';
import { CURRENT_PASSWORD_MISMATCH_MESSAGE } from './my-password.service';

/** 신고 정보 수집 목적(물리 ERD staff_tax_profiles.purpose) — 직원이 고르지 않는다 */
export const TAX_PROFILE_PURPOSE = '취득 신고 · 원천징수 · 급여 이체';

/** 주민등록번호 뒷자리 첫 자리 → 출생 세기. 외국인등록번호(5~8)도 같은 규칙이다 */
const CENTURY: Record<string, number> = {
  '9': 1800,
  '0': 1800,
  '1': 1900,
  '2': 1900,
  '5': 1900,
  '6': 1900,
  '3': 2000,
  '4': 2000,
  '7': 2000,
  '8': 2000,
};

/** 주민등록번호 앞 7자리가 가리키는 생년월일(YYYY-MM-DD) */
export function birthDateOfRrn(rrn: string): string {
  return `${CENTURY[rrn[6]] + Number(rrn.slice(0, 2))}-${rrn.slice(2, 4)}-${rrn.slice(4, 6)}`;
}

const badRequest = (code: string, message: string) =>
  new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    error: 'Bad Request',
    code,
    message,
  });

/** 지금 비밀번호가 없거나 틀림 — 둘을 가르지 않는다(화면이 할 일이 같다: 지금 비밀번호를 다시 넣게) */
const currentPasswordMismatch = () =>
  badRequest('CURRENT_PASSWORD_MISMATCH', CURRENT_PASSWORD_MISMATCH_MESSAGE);

type TaxProfileRow = {
  rrnEncrypted: Uint8Array;
  bankCode: string;
  payrollAccountNumberEncrypted: Uint8Array;
  purpose: string;
  collectedAt: Date;
};

/**
 * 직원 앱 마이페이지의 소속 근무지 (WHALEERP-188). 소속을 누르면 근로계약서 · 급여명세서 · 신고 정보로 간다(2026-10-20).
 * 소속은 TO-DO 와 같은 「재직 직원」 기준(ACTIVE_STAFF)이다 — 급여도 이 정책(PAY-16 · CTR-29)을 따라야 한다. 임시저장 계약만
 * 있는 레코드 · 가입 전 · 퇴직한 레코드는 빠지고 퇴직 예정은 들어간다. 탈퇴 계정은 가드가 접속을 끊어 여기까지 오지 않는다.
 * 점포 삭제 표시는 거르지 않는다 — 점포는 미운영이고 진행 중인 근로계약이 없어야 지울 수 있어, 지운 점포에 이 조건의 소속이
 * 남지 않는다.
 */
@Injectable()
export class MyMembershipsService {
  private readonly logger = new Logger(MyMembershipsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PERSONAL_DATA_KEY) private readonly key: Buffer | null,
  ) {}

  async list(accountId: number): Promise<MyMembershipListResponseDto> {
    const rows = await this.prisma.staffMember.findMany({
      where: { accountId, ...ACTIVE_STAFF },
      orderBy: [
        { hiredDate: { sort: 'asc', nulls: 'last' } },
        { staffMemberId: 'asc' },
      ],
      select: {
        staffMemberId: true,
        employmentType: true,
        jobTitle: true,
        hiredDate: true,
        retiredDate: true,
        storeId: true,
      },
    });

    // 직원 레코드의 store_id 는 1팀 점포를 가리키지만 Prisma 관계가 없다(팀 경계) — 따로 한 번에 읽는다.
    const stores = rows.length
      ? await this.prisma.store.findMany({
          where: { storeId: { in: [...new Set(rows.map((s) => s.storeId))] } },
          select: { storeId: true, name: true, storeTypeCode: true },
        })
      : [];
    const storeById = new Map(stores.map((st) => [st.storeId, st]));

    const items = rows.map((s) => {
      const store = storeById.get(s.storeId);
      // 외래키가 있어 늘 있다. 빠졌다면 맥락 없는 TypeError 대신 어느 레코드인지 남긴다
      if (!store)
        throw new Error(
          `소속의 점포가 없습니다 — staffMemberId=${s.staffMemberId} storeId=${s.storeId}`,
        );
      return {
        staffMemberId: s.staffMemberId,
        store: {
          storeId: store.storeId,
          storeName: store.name,
          storeTypeCode: store.storeTypeCode,
        },
        employmentType: s.employmentType,
        jobTitle: s.jobTitle,
        hiredDate: dateOnly(s.hiredDate),
        retiredDate: dateOnly(s.retiredDate),
      };
    });
    return { items, total: items.length };
  }

  /** 내 소속(목록과 같은 조건)이 아니면 404 — 남의 레코드도, 퇴직했거나 임시저장 계약만 있는 내 레코드도 없는 것과 같다 */
  async taxProfile(
    accountId: number,
    staffMemberId: number,
  ): Promise<MyTaxProfileResponseDto> {
    const staff = await this.prisma.staffMember.findFirst({
      where: { staffMemberId, accountId, ...ACTIVE_STAFF },
      select: {
        staffMemberId: true,
        staffTaxProfile: {
          select: {
            rrnEncrypted: true,
            bankCode: true,
            payrollAccountNumberEncrypted: true,
            purpose: true,
            collectedAt: true,
          },
        },
      },
    });
    if (!staff) throw new NotFoundException('소속을 찾을 수 없습니다');
    return {
      staffMemberId: staff.staffMemberId,
      taxProfile: staff.staffTaxProfile
        ? this.open(staff.staffMemberId, staff.staffTaxProfile)
        : null,
    };
  }

  /**
   * 신고 정보 작성 · 수정(WHALEERP-334). 내 소속(목록 · 조회와 같은 조건)만 — 아니면 404. 관리자 토큰은 컨트롤러가 막는다.
   * - 처음 작성할 때는 주민등록번호 · 은행 · 계좌번호를 모두 받는다. 고칠 때는 주민등록번호만, 또는 급여 계좌(은행 · 계좌번호를
   *   함께)만 받아도 되고 보내지 않은 항목은 그대로 둔다.
   * - 주민등록번호 앞 7자리가 가입한 생년월일과 다르면 받지 않는다 — 관리자에게 정정을 요청하게 안내한다(진입 · 가입 화면 가이드).
   *   주민등록번호를 새로 받으면 수집 일시를 지금으로 바꾸고, 이전 값은 덮어써 남기지 않는다(TAX-7 법무 검토 전 기준).
   * - 급여 계좌를 바꾸면 다음 급여부터 쓴다 — 급여명세서는 계좌를 따로 두지 않아 지금 할 일은 저장뿐이다.
   * - 값은 #79 와 같은 키 · AAD 로 암호화한다(조회가 풀 수 있게). 키가 없으면 503.
   * - 실제로 바뀐 항목만 쓰고 이력(staff_tax_profile_histories)을 한 행씩 남긴다 — 무엇을 · 언제 · 누가만, 값은 남기지
   *   않는다. 처음 작성은 두 항목 모두 남긴다. 화면이 기존 값을 다시 채워 보내도 이력이 흐려지지 않게, 암호문은 IV 가 달라
   *   풀어서 비교한다(api #86 리뷰). 같은 주민등록번호면 수집 일시도 그대로이고, 바뀐 것이 없으면 아무것도 쓰지 않는다.
   * - 저장값을 풀 수 없으면(손상 · 키 바뀜) 보낸 칸이든 아니든 500 이고 아무것도 쓰지 않는다 — 덮어쓰게 하면 키를 잘못
   *   배포했을 때 직원들이 다시 낸 값이 잘못된 키로 봉해져, 원래 키로 되돌린 뒤 풀 수 없게 된다(2026-10-21 김민식). 응답(가린
   *   값)도 트랜잭션 안에서 만들어, 응답을 만들 수 없으면 쓰기도 되돌린다 — 저장은 되고 응답만 500 이 되지 않게.
   * - 이미 낸 신고 정보를 고칠 때는 지금 비밀번호가 맞아야 한다 — 토큰만 손에 넣은 사람이 급여 계좌를 자기 계좌로 바꾸지
   *   못하게(WHALEERP-333 · 334 후속, 2026-10-23). 없거나 틀리면 400 CURRENT_PASSWORD_MISMATCH. 처음 작성(날인 뒤 흐름)은 받지
   *   않고, 보내도 비교하지 않는다(형식은 DTO 가 본다 — 빈 문자열 등은 처음 작성에도 400). 순서는 내 소속(404) → 비밀번호 →
   *   나머지 검사다(본문 형식 · 모양 400 과 키 없음 503 은 그보다 앞) — 비밀번호보다 먼저 생년월일 · 은행 · 같은 값
   *   여부를 답하면 토큰만으로 주민등록번호 · 계좌를 맞혀 볼 수 있다. 틀려도 로그인 잠금 횟수는 세지 않고 요청 한도만 건다
   *   (이메일 변경 · 비밀번호 변경과 같다). scrypt 는 잠금 밖에서 하고, 잠근 뒤 해시를 다시 봐 그사이 바뀐 비밀번호로 고치지
   *   않는다(이메일 변경 핀 요청과 같다).
   */
  async saveTaxProfile(
    accountId: number,
    staffMemberId: number,
    dto: SaveMyTaxProfileDto,
  ): Promise<MyTaxProfileResponseDto> {
    const hasRrn = dto.rrn !== undefined;
    const hasAccount =
      dto.bankCode !== undefined || dto.payrollAccountNumber !== undefined;
    if (!hasRrn && !hasAccount)
      throw badRequest('TAX_PROFILE_EMPTY', '바꿀 값을 보내 주세요');
    if (
      hasAccount &&
      (dto.bankCode === undefined || dto.payrollAccountNumber === undefined)
    )
      throw badRequest(
        'TAX_PROFILE_ACCOUNT_INCOMPLETE',
        '급여 계좌는 은행과 계좌번호를 함께 보내 주세요',
      );
    const key = this.requireKey(staffMemberId);

    const mine = { staffMemberId, accountId, ...ACTIVE_STAFF };
    // 내 소속인지 먼저 본다 — 남의 레코드면 비밀번호를 보지 않고 404, 남의 직원 행도 잠그지 않는다.
    if (!(await this.prisma.staffMember.count({ where: mine })))
      throw new NotFoundException('소속을 찾을 수 없습니다');
    // 고치는 경우에만 지금 비밀번호를 본다. 확인한 해시는 잠근 뒤 다시 본다
    const verifiedHash = (await this.prisma.staffTaxProfile.count({
      where: { staffMemberId },
    }))
      ? await this.verifyCurrentPassword(accountId, dto.currentPassword)
      : null;

    const taxProfile = await this.prisma.$transaction(async (tx) => {
      // 직원 행을 잡은 뒤 소속 · 가입 생년월일을 다시 읽어, 그사이 퇴직 확정이 커밋됐으면 쓰지 않는다(api #86 재리뷰 — 퇴직
      // lockStaff 도 잠근 뒤 읽는다). 잡으면 처음 작성을 두 번 보내도 뒤쪽은 앞쪽이 만든 것을 본다(api #86 리뷰 — PK 에서
      // 500 이었다) — 뒤쪽은 비밀번호를 보지 않았으니 고치지 않고 400 이다
      await tx.$queryRaw`
        SELECT 1 FROM staff_members WHERE staff_member_id = ${staffMemberId} FOR UPDATE`;
      const staff = await tx.staffMember.findFirst({
        where: mine,
        select: { account: { select: { birthDate: true } } },
      });
      if (!staff) throw new NotFoundException('소속을 찾을 수 없습니다');
      const select = {
        rrnEncrypted: true,
        bankCode: true,
        payrollAccountNumberEncrypted: true,
        purpose: true,
        collectedAt: true,
      } as const;
      const current = await tx.staffTaxProfile.findUnique({
        where: { staffMemberId },
        select,
      });
      const creating = !current;
      if (!creating) {
        if (verifiedHash === null) throw currentPasswordMismatch();
        // 확인한 사이 재설정 · 비밀번호 변경이 먼저 끝났으면, 확인한 비밀번호는 이미 지금 비밀번호가 아니다. 공유 잠금으로
        // 커밋까지 비밀번호 변경을 세운다 — 순서는 직원 행 → 계정 행(가입 연결이 직원 행을 잡은 뒤 계정을 참조하는 것과 같다)
        await tx.$queryRaw`
          SELECT 1 FROM accounts WHERE account_id = ${accountId} FOR SHARE`;
        const { passwordHash } = await tx.account.findUniqueOrThrow({
          where: { accountId },
          select: { passwordHash: true },
        });
        if (passwordHash !== verifiedHash) throw currentPasswordMismatch();
      }
      if (creating && !(hasRrn && hasAccount))
        throw badRequest(
          'TAX_PROFILE_INCOMPLETE',
          '처음 낼 때는 주민등록번호와 급여 계좌(은행 · 계좌번호)를 모두 보내 주세요',
        );
      if (
        hasRrn &&
        staff.account &&
        birthDateOfRrn(dto.rrn as string) !==
          staff.account.birthDate.toISOString().slice(0, 10)
      )
        throw badRequest(
          'RRN_BIRTH_MISMATCH',
          '주민등록번호 앞자리가 가입한 생년월일과 다릅니다. 근무지 관리자에게 정정을 요청해 주세요',
        );
      if (hasAccount) {
        const bank = await tx.codeItem.count({
          where: {
            groupCode: 'BANK',
            itemCode: dto.bankCode,
            status: 'ACTIVE',
            isDeleted: false,
          },
        });
        if (!bank)
          throw badRequest('BANK_CODE_UNKNOWN', '은행을 다시 골라 주세요');
      }

      // 보낸 칸은 풀어서 비교한다 — 풀 수 없으면 500(reveal), 덮어쓰지 않는다
      const plainOf = (
        column: 'rrn_encrypted' | 'payroll_account_number_encrypted',
        sealed: Uint8Array,
      ) => this.reveal(key, staffMemberId, column, sealed, (plain) => plain);
      const rrnChanged =
        hasRrn &&
        (!current ||
          plainOf('rrn_encrypted', current.rrnEncrypted) !== dto.rrn);
      const accountChanged =
        hasAccount &&
        (!current ||
          current.bankCode !== dto.bankCode ||
          plainOf(
            'payroll_account_number_encrypted',
            current.payrollAccountNumberEncrypted,
          ) !== dto.payrollAccountNumber);
      if (current && !rrnChanged && !accountChanged)
        return this.open(staffMemberId, current);

      const now = new Date();
      const data = {
        ...(rrnChanged
          ? {
              rrnEncrypted: encryptPersonalData(
                key,
                dto.rrn as string,
                staffTaxProfileAad('rrn_encrypted', staffMemberId),
              ),
              collectedAt: now,
            }
          : {}),
        ...(accountChanged
          ? {
              bankCode: dto.bankCode as string,
              payrollAccountNumberEncrypted: encryptPersonalData(
                key,
                dto.payrollAccountNumber as string,
                staffTaxProfileAad(
                  'payroll_account_number_encrypted',
                  staffMemberId,
                ),
              ),
            }
          : {}),
      };
      await tx.staffTaxProfileHistory.createMany({
        data: [
          ...(rrnChanged ? (['RRN'] as const) : []),
          ...(accountChanged ? (['PAYROLL_ACCOUNT'] as const) : []),
        ].map((field) => ({ staffMemberId, field, accountId, changedAt: now })),
      });
      const saved = await (creating
        ? tx.staffTaxProfile.create({
            data: {
              staffMemberId,
              purpose: TAX_PROFILE_PURPOSE,
              ...(data as Required<typeof data>),
            },
            select,
          })
        : tx.staffTaxProfile.update({
            where: { staffMemberId },
            data,
            select,
          }));
      return this.open(staffMemberId, saved);
    });
    return { staffMemberId, taxProfile };
  }

  /** 지금 비밀번호가 맞으면 확인한 해시를 준다. 없거나 틀리면 400 — 원문은 어디에도 남기지 않는다 */
  private async verifyCurrentPassword(
    accountId: number,
    currentPassword: string | undefined,
  ): Promise<string> {
    if (currentPassword === undefined) throw currentPasswordMismatch();
    const { passwordHash } = await this.prisma.account.findUniqueOrThrow({
      where: { accountId },
      select: { passwordHash: true },
    });
    if (!(await verifyPassword(currentPassword, passwordHash)))
      throw currentPasswordMismatch();
    return passwordHash;
  }

  /** 키가 없으면 503 — 신고 정보를 읽지도 쓰지도 못한다 */
  private requireKey(staffMemberId: number): Buffer {
    if (this.key) return this.key;
    this.logger.error(
      `PERSONAL_DATA_ENCRYPTION_KEY 가 비어 신고 정보를 다룰 수 없습니다 — staffMemberId=${staffMemberId}`,
    );
    throw new ServiceUnavailableException(
      '신고 정보를 지금 다룰 수 없습니다. 잠시 뒤 다시 시도해 주세요',
    );
  }

  /**
   * 풀어서 가린 값만 돌려준다. 키가 없으면 503, 풀 수 없거나(키 다름 · 다른 행에서 옮겨 온 암호문 · 손상) 형식이 깨졌으면
   * 500 이다. 어느 레코드의 어느 칸인지는 로그에만 남기고 원문은 어디에도 남기지 않는다 — 가림 함수의 오류도 입력을 싣지 않는다.
   */
  private open(staffMemberId: number, row: TaxProfileRow): MyTaxProfileDto {
    const key = this.key;
    if (!key) {
      this.logger.error(
        `PERSONAL_DATA_ENCRYPTION_KEY 가 비어 신고 정보를 풀 수 없습니다 — staffMemberId=${staffMemberId}`,
      );
      throw new ServiceUnavailableException(
        '신고 정보를 지금 볼 수 없습니다. 잠시 뒤 다시 시도해 주세요',
      );
    }
    return {
      rrnMasked: this.reveal(
        key,
        staffMemberId,
        'rrn_encrypted',
        row.rrnEncrypted,
        maskRrn,
      ),
      bankCode: row.bankCode,
      payrollAccountNumberMasked: this.reveal(
        key,
        staffMemberId,
        'payroll_account_number_encrypted',
        row.payrollAccountNumberEncrypted,
        maskAccountNumber,
      ),
      purpose: row.purpose,
      collectedAt: row.collectedAt,
    };
  }

  /**
   * 한 칸을 풀어 `mask` 를 거친 값을 준다 — 응답(`open`)과 저장 때 보내지 않은 칸의 미리 확인이 같은 가림 함수를 거쳐야,
   * 미리 확인을 통과한 칸이 응답에서 실패하지 않는다. 풀 수 없거나 가림 함수가 실패하면 500 — 어느 레코드의 어느 칸인지는
   * 로그에만 남긴다.
   */
  private reveal(
    key: Buffer,
    staffMemberId: number,
    column: 'rrn_encrypted' | 'payroll_account_number_encrypted',
    sealed: Uint8Array,
    mask: (plain: string) => string,
  ): string {
    try {
      return mask(
        decryptPersonalData(
          key,
          sealed,
          staffTaxProfileAad(column, staffMemberId),
        ),
      );
    } catch (err) {
      this.logger.error(
        `신고 정보를 풀 수 없습니다 — staffMemberId=${staffMemberId} 칸=${column}: ${(err as Error).message}`,
        (err as Error).stack,
      );
      throw new InternalServerErrorException('신고 정보를 읽을 수 없습니다', {
        cause: err,
      });
    }
  }
}
