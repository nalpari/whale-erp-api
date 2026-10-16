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

// 근로계약 발송 · 재발송(WHALEERP-136). 근로계약 관리(ContractsController)와 같은 경로 · 권한이고, 알림톡 모듈에 기대는
// 부분만 따로 둔다.
@ApiBearerAuth()
@ApiForbiddenResponse({
  description: '직원 앱 토큰이거나 사용 중인 관리자 계정이 아님',
})
@UserTypes('admin')
@Controller('contracts')
export class ContractSendController {
  constructor(private readonly sender: ContractSendService) {}

  /**
   * 발송(발송 대기 → 서명 대기) · 재발송(서명 대기 그대로, 새 링크 · 새 기한). 계정이 없는 직원에게 가입 초대 알림톡을
   * 보낸다 — 링크 30일, 서명 기한도 발송일로부터 30일.
   */
  @Post(':contractId/send')
  @HttpCode(200)
  @ApiOkResponse({
    description:
      '{ contractId, status: PENDING_SIGNATURE, sentAt, signDeadlineAt }',
  })
  @ApiNotFoundResponse({ description: '없는 계약 · 업무 범위 밖' })
  @ApiConflictResponse({
    description:
      'CONTRACT_STATUS_CONFLICT(발송 대기 · 서명 대기가 아님) · SEND_CHANNEL_NOT_READY(기존 계정 — 앱 알림 준비 전) · SEND_PHONE_NOT_MOBILE(휴대폰 번호가 아님) · 다른 요청이 먼저 고침',
  })
  @ApiBadGatewayResponse({
    description:
      'SEND_FAILED(나가지 않음 — 거절 · 토큰 단계 · 요청 전 오류, 되돌렸고 다시 보낼 수 있음) · SEND_UNCONFIRMED(접수 여부 모름 또는 되돌리기 실패 — 상세를 다시 읽을 것)',
  })
  @ApiServiceUnavailableResponse({
    description:
      '직원 앱 주소(STAFF_APP_URL) · 대체 문자 발신번호(BIZPPURIO_SMS_FROM)가 없음 · 가입 초대 템플릿이 없거나 꺼짐',
  })
  send(
    @Param('contractId', ContractIdPipe) contractId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<SendResult> {
    return this.sender.send(user.id, contractId);
  }
}
