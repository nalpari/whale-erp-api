import type { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { PlatformAdminMail } from './platform-admin-mail';

type Tx = Prisma.TransactionClient;

/** 초기 · 초기화 비밀번호는 1시간 쓸 수 있다(temporary_passwords.expires_at). */
const TEMP_PASSWORD_MS = 60 * 60_000;

/** 쓸 수 있는 비밀번호가 없다는 표시. verifyPassword 가 어떤 입력과도 맞추지 않는다(/etc/shadow 관례). */
export const LOCKED_PASSWORD = '!';

/*
 * 관리자 계정의 초기 · 초기화 비밀번호. 플랫폼 관리자 관리와 BP 관리자 관리가 같은 순서로 쓴다 —
 * 트랜잭션에서 「미발송」을 켜고 비밀번호를 낸 뒤, 커밋 뒤 메일이 나가면 그 비밀번호가 살아 있을 때만 내린다.
 */

/**
 * 살아 있는 임시 비밀번호를 모두 무효로 하고 그 수를 돌려준다. 로그인에 한 번 쓴 것도 막는다 — 로그인은 만료 전이면
 * 쓴 것으로도 다시 들어오고(AdminAuthService.liveTemporary), 강제 변경도 쓴 것을 근거로 받는다. 남기면 이메일을
 * 바꾸거나 초기화해도 앞서 받은 사람이 남은 시간 동안 들어와 비밀번호를 정할 수 있다.
 */
export async function invalidateTempPasswords(
  tx: Tx,
  adminAccountId: number,
  by: number,
): Promise<number> {
  const { count } = await tx.temporaryPassword.updateMany({
    where: {
      adminAccountId,
      invalidatedAt: null,
      isDeleted: false,
    },
    data: { invalidatedAt: new Date(), updatedBy: by },
  });
  return count;
}

/**
 * 이메일을 바꿀 때. 옛 주소로 나간(또는 나가는 중인) 임시 비밀번호는 옛 주소의 주인이 쓸 수 있어 용도와 상관없이
 * 모두 막는다. 막았으면 쓸 수 있는 비밀번호가 없는 계정(LOCKED_PASSWORD — 등록 · 초기화 뒤 아직 바꾸지 않음)만
 * 「미발송」을 켜 초기화하게 한다. 비밀번호 찾기의 임시 비밀번호만 막힌 계정은 원래 비밀번호로 로그인되므로 켜지
 * 않는다 — 켜면 그것을 보고 누른 초기화가 쓰던 비밀번호를 막는다.
 */
export async function voidTempPasswordsForEmailChange(
  tx: Tx,
  adminAccountId: number,
  by: number,
): Promise<void> {
  if ((await invalidateTempPasswords(tx, adminAccountId, by)) === 0) return;
  await tx.adminAccount.updateMany({
    where: { adminAccountId, passwordHash: LOCKED_PASSWORD },
    data: { isInitialPasswordUnsent: true },
  });
}

/** 앞서 낸 쓰지 않은 비밀번호는 무효로 하고 새 것을 1시간짜리로 낸다. 새 비밀번호의 id 를 돌려준다. */
export async function issueTempPassword(
  tx: Tx,
  adminAccountId: number,
  passwordHash: string,
  purpose: 'INITIAL' | 'RESET',
  by: number,
): Promise<number> {
  await invalidateTempPasswords(tx, adminAccountId, by);
  const { temporaryPasswordId } = await tx.temporaryPassword.create({
    data: {
      adminAccountId,
      passwordHash,
      purpose,
      expiresAt: new Date(Date.now() + TEMP_PASSWORD_MS),
      createdBy: by,
      updatedBy: by,
    },
    select: { temporaryPasswordId: true },
  });
  return temporaryPasswordId;
}

/**
 * 메일이 나간 비밀번호가 아직 살아 있을 때만 「미발송」을 내린다. 그 사이 다른 초기화나 이메일 변경이 무효로
 * 했으면 그 메일은 쓸모가 없다 — 먼저 끝난 메일이 끄면 뒤 메일이 실패해도 「보냄」으로 보인다. 내리기 직전과
 * 직후의 updatedAt 을 돌려주고, 내리지 않았으면 null.
 *
 * 계정 행을 먼저 잠그고(FOR NO KEY UPDATE) 그다음 문장에서 비밀번호를 확인한다. 초기화 · 이메일 변경은 이
 * 행을 먼저 고친 뒤 비밀번호를 무효로 하므로, 잠금을 얻은 뒤의 새 문장은 그 무효화를 본다. 한 문장의
 * UPDATE … WHERE EXISTS 로는 안 된다 — EXISTS 는 문장 시작 때 스냅숏으로 판정돼, 잠금을 기다린 뒤에도
 * 그 사이 커밋된 무효화를 보지 못한다.
 */
export async function markSent(
  prisma: PrismaService,
  adminAccountId: number,
  temporaryPasswordId: number,
): Promise<{ before: Date; after: Date } | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT 1 FROM admin_accounts
       WHERE admin_account_id = ${adminAccountId}
         FOR NO KEY UPDATE`;
    const live = await tx.temporaryPassword.findFirst({
      where: {
        temporaryPasswordId,
        adminAccountId,
        invalidatedAt: null,
        isDeleted: false,
      },
      select: { temporaryPasswordId: true },
    });
    if (!live) return null;
    const { updatedAt: before } = await tx.adminAccount.findUniqueOrThrow({
      where: { adminAccountId },
      select: { updatedAt: true },
    });
    const { updatedAt: after } = await tx.adminAccount.update({
      where: { adminAccountId },
      data: { isInitialPasswordUnsent: false },
      select: { updatedAt: true },
    });
    return { before, after };
  });
}

/**
 * 비밀번호 메일. 값은 메일 이력(mail_send_logs)에서 가린다. 바로가기 버튼(#{링크})은 관리자 웹으로 간다.
 * 실패는 던지지 않고 false — 「미발송」은 트랜잭션이 이미 켜 두었으므로 그대로 남고, 호출부는 true 일 때만
 * 내린다. 메일 설정이 없는 환경(발송 수단 null)도 같은 false 다 — api 는 떠 있고 이 메일만 못 보낸다.
 */
export async function sendPassword(
  sender: PlatformAdminMail,
  logger: Logger,
  adminAccountId: number,
  sentBy: number,
  mail: {
    templateCode: string;
    to: string;
    variables: Record<string, string>;
  },
): Promise<boolean> {
  if (sender === null) {
    logger.warn(
      `${mail.templateCode} 보내지 않음 adminAccountId=${adminAccountId} — MAIL_* · ADMIN_WEB_URL 이 없다`,
    );
    return false;
  }
  try {
    await sender.mail.send({
      ...mail,
      variables: { ...mail.variables, 링크: sender.webUrl },
      maskedVariables: ['임시비밀번호'],
      adminAccountId,
      sentBy,
    });
    return true;
  } catch (error) {
    const { name, code, message, stack } = (error ?? {}) as {
      name?: string;
      code?: string;
      message?: string;
      stack?: string;
    };
    const head = `${mail.templateCode} 발송 실패 adminAccountId=${adminAccountId} sentBy=${sentBy} error=${name}`;
    // SMTP 오류(code 가 있다)는 원문에 받는 주소가 들어 있고, MailService 가 가린 채 이미 남겼다.
    // 그 앞 검증(템플릿 · 변수 · 링크)의 실패는 MailService 가 남기지 않고 mail_send_logs 에도 없다 —
    // 원인이 여기에만 남으므로 메시지와 stack 을 찍는다. 그 메시지에는 주소 원문이 없다.
    if (code) logger.warn(`${head} code=${code}`);
    else logger.warn(`${head}: ${message}`, stack);
    return false;
  }
}

/**
 * 커밋 · 메일 뒤의 마무리 쓰기. 실패해도 던지지 않고 남긴다 — 계정 · 비밀번호는 이미 바뀌었으므로
 * 500 을 주면 화면이 다시 등록(아이디 중복 409)하거나 다시 초기화(앞 메일의 비밀번호 무효)하게 된다.
 */
export async function afterCommit(
  logger: Logger,
  adminAccountId: number,
  what: string,
  write: () => Promise<unknown>,
): Promise<void> {
  try {
    await write();
  } catch (error) {
    // Prisma 메시지는 인자를 통째로 담으므로 찍지 않는다(MailService.record 와 같다).
    // stack 의 첫 줄이 「name: message」라 그 줄을 떼고 위치만 남긴다.
    const { name, code, stack } = (error ?? {}) as {
      name?: string;
      code?: string;
      stack?: string;
    };
    logger.error(
      `${what} 실패 adminAccountId=${adminAccountId} error=${name} code=${code}`,
      stack?.split('\n').slice(1).join('\n'),
    );
  }
}
