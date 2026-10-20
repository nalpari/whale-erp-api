import {
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  decryptPersonalData,
  staffTaxProfileAad,
} from '../common/personal-data-cipher';
import { PERSONAL_DATA_KEY } from '../common/personal-data-key.provider';
import { maskAccountNumber, maskRrn } from '../common/personal-data-mask';
import { PrismaService } from '../prisma/prisma.service';
import { ACTIVE_STAFF } from '../todos/todo-rules';
import { dateOnly } from './date-only';
import type {
  MyMembershipListResponseDto,
  MyTaxProfileDto,
  MyTaxProfileResponseDto,
} from './dto/my-membership.response.dto';

type TaxProfileRow = {
  rrnEncrypted: Uint8Array;
  bankCode: string;
  payrollAccountNumberEncrypted: Uint8Array;
  purpose: string;
  collectedAt: Date;
};

/**
 * 직원 앱 마이페이지의 소속 근무지 (WHALEERP-188). 소속을 누르면 근로계약서 · 급여명세서 · 신고 정보로 간다(2026-10-20).
 * 소속은 TO-DO · 급여와 같은 「재직 직원」 기준(ACTIVE_STAFF)이라, 임시저장 계약만 있는 레코드 · 가입 전 · 퇴직한 레코드는
 * 빠지고 퇴직 예정은 들어간다. 탈퇴 계정은 가드가 접속을 끊어 여기까지 오지 않는다.
 */
@Injectable()
export class MyMembershipsService {
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
      // 외래키가 있어 점포는 늘 있다
      const store = storeById.get(s.storeId)!;
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

  /** 내 소속(목록과 같은 조건)이 아니면 404 — 남의 레코드도, 퇴직한 내 레코드도 없는 것과 같다 */
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

  /** 풀어서 가린 값만 돌려준다. AAD 가 행 id 를 담아, 다른 행에서 옮겨 온 암호문이면 던진다 */
  private open(staffMemberId: number, row: TaxProfileRow): MyTaxProfileDto {
    const key = this.key;
    if (!key)
      throw new ServiceUnavailableException(
        '신고 정보를 읽을 수 없습니다(암호화 키가 설정되지 않았습니다)',
      );
    return {
      rrnMasked: maskRrn(
        decryptPersonalData(
          key,
          row.rrnEncrypted,
          staffTaxProfileAad('rrn_encrypted', staffMemberId),
        ),
      ),
      bankCode: row.bankCode,
      payrollAccountNumberMasked: maskAccountNumber(
        decryptPersonalData(
          key,
          row.payrollAccountNumberEncrypted,
          staffTaxProfileAad('payroll_account_number_encrypted', staffMemberId),
        ),
      ),
      purpose: row.purpose,
      collectedAt: row.collectedAt,
    };
  }
}
