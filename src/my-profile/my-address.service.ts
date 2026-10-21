import { Injectable, UnauthorizedException } from '@nestjs/common';
import { INVALID_SESSION_MESSAGE } from '../auth-session/auth-session.service';
import { PrismaService } from '../prisma/prisma.service';

export interface MyAddress {
  zipCode: string;
  address: string;
  addressDetail?: string | null;
}

interface AddressColumns {
  zipCode: string | null;
  address: string | null;
  addressDetail: string | null;
}

/** 이력에 남기는 한 줄 — `(우편번호) 도로명 주소 상세 주소`. 주소가 없으면 null */
function addressText(a: AddressColumns): string | null {
  if (a.address === null) return null;
  return [a.zipCode && `(${a.zipCode})`, a.address, a.addressDetail]
    .filter(Boolean)
    .join(' ');
}

/**
 * 직원 앱 주소 수정 (WHALEERP-189). 주소는 계정(`accounts`)에만 있고 직원 레코드는 그 계정을 읽으므로, 여기서 한 번
 * 바꾸면 모든 소속에 같이 보인다. 이미 보낸 근로계약서는 당사자 칸(`contract_parties`)의 사본이라 바뀌지 않는다. 그
 * 사본을 채우는 서명 흐름(아직 없음)은 그때의 계정 주소를 복사해야 한다.
 */
@Injectable()
export class MyAddressService {
  constructor(private readonly prisma: PrismaService) {}

  async update(accountId: number, input: MyAddress): Promise<void> {
    const after: AddressColumns = {
      zipCode: input.zipCode,
      address: input.address,
      addressDetail: input.addressDetail ?? null,
    };
    await this.prisma.$transaction(async (tx) => {
      // 같은 계정의 저장이 겹치면 이력의 변경 전 값이 어긋난다 — 한 번에 하나씩.
      await tx.$queryRaw`SELECT 1 FROM accounts WHERE account_id = ${accountId} FOR UPDATE`;
      const before = await tx.account.findUniqueOrThrow({
        where: { accountId },
        select: {
          status: true,
          zipCode: true,
          address: true,
          addressDetail: true,
        },
      });
      if (before.status === 'WITHDRAWN')
        throw new UnauthorizedException(INVALID_SESSION_MESSAGE);
      // 같은지는 칸마다 본다 — 이어 붙인 글로 보면 「A」+「B」와 「A B」+없음이 같아 보인다.
      if (
        before.zipCode === after.zipCode &&
        before.address === after.address &&
        before.addressDetail === after.addressDetail
      )
        return;
      const beforeValue = addressText(before);
      const afterValue = addressText(after);

      await tx.account.update({ where: { accountId }, data: after });
      await tx.accountChangeHistory.create({
        data: {
          accountId,
          field: 'ADDRESS',
          channel: 'SELF',
          beforeValue,
          afterValue,
        },
      });
    });
  }
}
