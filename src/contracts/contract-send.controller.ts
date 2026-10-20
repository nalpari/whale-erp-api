import { Controller, HttpCode, Param, Post } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiServiceUnavailableResponse,
} from '@nestjs/swagger';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import { ContractIdPipe } from './contract-id.pipe';
import { ContractSendService, type SendResult } from './contract-send.service';

// 근로계약 재발송(WHALEERP-136). 보내기는 저장할 때 곧바로 한다(2026-10-19 재영) — 따로 부르는 것은 재발송뿐이다.
// 근로계약 관리(ContractsController)와 같은 경로 · 권한이다.
@ApiBearerAuth()
@ApiForbiddenResponse({
  description: '직원 앱 토큰이거나 사용 중인 관리자 계정이 아님',
})
@UserTypes('admin')
@Controller('contracts')
export class ContractSendController {
  constructor(private readonly sender: ContractSendService) {}

  /**
   * 재발송 — 발송 대기(가입 초대를 받지 못함) · 서명 대기에서 가입 초대 알림톡을 새 초대 코드 · 새 서명 기한(30일)으로 다시
   * 보낸다. 상태는 그대로이고 앞서 나간 초대 코드는 무효다. 앱으로 받는 직원(가입 · 계정 있음)은 앱 알림이 아직 없어 409.
   */
  @Post(':contractId/send')
  @HttpCode(200)
  @ApiOkResponse({
    description:
      '{ contractId, status(그대로 — PENDING_SEND · PENDING_SIGNATURE), sentAt, signDeadlineAt }',
  })
  @ApiNotFoundResponse({ description: '없는 계약 · 업무 범위 밖' })
  @ApiConflictResponse({
    description:
      'CONTRACT_STATUS_CONFLICT(발송 대기 · 서명 대기가 아님) · SEND_CHANNEL_NOT_READY(가입한 직원 · 계정이 있는 번호 — 앱 알림 준비 전) · SEND_PHONE_NOT_MOBILE(휴대폰 번호가 아님) · 다른 요청이 먼저 고침',
  })
  @ApiBadGatewayResponse({
    description:
      'SEND_FAILED(나가지 않음 — 거절 · 토큰 단계 · 요청 전 오류, 되돌렸고 다시 보낼 수 있음, 본문 contractId · status) · SEND_UNCONFIRMED(접수 여부 모름 또는 되돌리기 실패 — 상세를 다시 읽을 것)',
  })
  @ApiServiceUnavailableResponse({
    description:
      '직원 앱 주소(STAFF_APP_URL)가 없음 · 대체 문자 발신번호(BIZPPURIO_SMS_FROM)가 없음 · 가입 초대 템플릿이 없거나 꺼짐',
  })
  send(
    @Param('contractId', ContractIdPipe) contractId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<SendResult> {
    return this.sender.send(user.id, contractId);
  }
}
