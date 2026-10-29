import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { sameMillisecond } from '../common/updated-at';
import { voidTempPasswordsForEmailChange } from '../platform-admins/admin-password';
import { PrismaService } from '../prisma/prisma.service';
import type { AdminProfileUpdateDto } from './dto/admin-profile-update.dto';
import type { AdminProfileResponseDto } from './dto/admin-profile.response.dto';

type Tx = Prisma.TransactionClient;
const NOT_FOUND = '관리자 계정을 찾을 수 없습니다.';

type History = {
  field: string;
  beforeValue: string | null;
  afterValue: string | null;
};

/**
 * 내 정보(마이페이지) 조회 · 수정 (manyfast F-AMTDCK > S-JXKHCM). 로그인한 관리자 본인의
 * admin_accounts 행만 다룬다 — 다른 관리자 계정은 platform-admins(플랫폼 관리자만) 가 다룬다.
 * 플랫폼 마스터 · 플랫폼 관리자뿐 아니라 BP 마스터 · BP 관리자 · 가맹 마스터 · 가맹 관리자도 쓴다
 * (컨트롤러 가드는 UserTypes('admin') 전체를 통과시킨다).
 */
@Injectable()
export class AdminProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async get(adminAccountId: number): Promise<AdminProfileResponseDto> {
    const account = await this.find(this.prisma, adminAccountId);
    return this.toDto(account);
  }

  /**
   * 기본정보 저장. 이메일이 바뀌면(탈퇴 제외 다른 계정과) 중복을 다시 본다 — 화면의 칸 벗어날 때
   * 확인은 참고일 뿐이고, 저장 순간의 중복만 믿는다. 바꾼 칸만 변경 이력에 남긴다.
   *
   * 동시 수정은 updatedAt 으로 가린다(platform-admins update 와 같은 패턴, 코드 리뷰로 찾음,
   * 2026-10-21) — 그사이 플랫폼 관리자가 이 계정을 platform-admins 에서 고쳤으면 409, 조용히
   * 덮어쓰지 않는다. 이메일이 바뀌면 옛 주소로 나간 쓰지 않은 임시 비밀번호도 무효로 한다 — 안
   * 그러면 옛 메일함의 주인이 그 비밀번호로 로그인할 수 있었다.
   *
   * 이메일을 바꿔도 지금 비밀번호는 보지 않는다(manyfast S-JXKHCM, 2026-10-22 · 10-23 사용자 결정).
   * 2026-10-21 적대적 리뷰로 넣었던 확인을 뺐다 — 탈취한 접근 토큰만으로 로그인 이메일을 바꿔
   * 비밀번호 찾기를 가로챌 수 있는 경로가 다시 열린다는 것을 알리고 확인받았다. 직원 앱
   * my-profile 의 email-change 는 이 결정과 상관없이 그대로 지금 비밀번호를 본다.
   */
  async update(
    adminAccountId: number,
    input: AdminProfileUpdateDto,
  ): Promise<void> {
    await this.prisma
      .$transaction(async (tx) => {
        const target = await this.find(tx, adminAccountId);
        const emailChanged = input.email !== target.email;

        if (
          emailChanged &&
          (await this.findEmailOwner(tx, input.email, adminAccountId))
        )
          throw new ConflictException('이미 등록된 이메일입니다.');

        const { count } = await tx.adminAccount.updateMany({
          where: {
            adminAccountId,
            updatedAt: sameMillisecond(input.updatedAt),
          },
          data: {
            name: input.name,
            phone: input.phone,
            email: input.email,
            updatedBy: adminAccountId,
          },
        });
        if (count === 0)
          throw new ConflictException(
            '다른 관리자가 먼저 수정했습니다. 최신 정보를 불러온 뒤 다시 저장해 주세요.',
          );

        if (emailChanged)
          await voidTempPasswordsForEmailChange(
            tx,
            adminAccountId,
            adminAccountId,
          );

        const changes = [
          change('이름', target.name, input.name),
          change('연락처', target.phone, input.phone),
          change('이메일', target.email, input.email),
        ].filter((c): c is History => c !== null);
        if (changes.length)
          await tx.adminChangeHistory.createMany({
            data: changes.map((c) => ({
              adminAccountId,
              ...c,
              changedBy: adminAccountId,
            })),
          });
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw new ConflictException('이미 등록된 이메일입니다.');
        throw error;
      });
  }

  /** GET .../email-availability — 탈퇴하지 않은 다른 관리자 계정과 겹치는지만 본다. 원래 이메일 그대로면 화면이 묻지 않는다. */
  async checkEmailAvailable(
    adminAccountId: number,
    email: string,
  ): Promise<boolean> {
    const owner = await this.findEmailOwner(
      this.prisma,
      email.toLowerCase(),
      adminAccountId,
    );
    return !owner;
  }

  private find(db: Tx | PrismaService, adminAccountId: number) {
    const account = db.adminAccount.findFirst({
      where: { adminAccountId, isDeleted: false },
    });
    return account.then((a) => {
      if (!a) throw new NotFoundException(NOT_FOUND);
      return a;
    });
  }

  private findEmailOwner(
    db: Tx | PrismaService,
    email: string,
    exceptAdminAccountId: number,
  ) {
    return db.adminAccount.findFirst({
      where: {
        email,
        isDeleted: false,
        accountStatusCode: { not: 'WITHDRAWN' },
        adminAccountId: { not: exceptAdminAccountId },
      },
      select: { adminAccountId: true },
    });
  }

  private toDto(account: {
    loginId: string;
    name: string | null;
    phone: string | null;
    email: string | null;
    roleTypeCode: string;
    createdAt: Date;
    lastLoginAt: Date | null;
    updatedAt: Date;
  }): AdminProfileResponseDto {
    return {
      loginId: account.loginId,
      name: account.name ?? '',
      phone: account.phone ?? '',
      email: account.email ?? '',
      roleTypeCode: account.roleTypeCode,
      createdAt: account.createdAt,
      lastLoginAt: account.lastLoginAt,
      updatedAt: account.updatedAt,
    };
  }
}

function change(
  field: string,
  beforeValue: string | null,
  afterValue: string | null,
): History | null {
  return beforeValue === afterValue ? null : { field, beforeValue, afterValue };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
