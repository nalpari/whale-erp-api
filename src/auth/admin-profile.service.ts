import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AdminProfileUpdateDto } from './dto/admin-profile-update.dto';
import type { AdminProfileResponseDto } from './dto/admin-profile.response.dto';

type Tx = Prisma.TransactionClient;
const NOT_FOUND = '관리자 계정을 찾을 수 없습니다';

type History = {
  field: string;
  beforeValue: string | null;
  afterValue: string | null;
};

/**
 * 내 정보(MY PAGE) 조회 · 수정 (manyfast F-AMTDCK > S-JXKHCM). 로그인한 관리자 본인의
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
   */
  async update(
    adminAccountId: number,
    input: AdminProfileUpdateDto,
  ): Promise<void> {
    await this.prisma
      .$transaction(async (tx) => {
        const target = await this.find(tx, adminAccountId);

        if (
          input.email !== target.email &&
          (await this.findEmailOwner(tx, input.email, adminAccountId))
        )
          throw new ConflictException('이미 등록된 이메일입니다.');

        await tx.adminAccount.update({
          where: { adminAccountId },
          data: { name: input.name, phone: input.phone, email: input.email },
        });

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
  }): AdminProfileResponseDto {
    return {
      loginId: account.loginId,
      name: account.name ?? '',
      phone: account.phone ?? '',
      email: account.email ?? '',
      roleTypeCode: account.roleTypeCode,
      createdAt: account.createdAt,
      lastLoginAt: account.lastLoginAt,
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
