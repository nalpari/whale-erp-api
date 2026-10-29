import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBody,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiServiceUnavailableResponse,
} from '@nestjs/swagger';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import { MenuPermission } from '../auth/menu-permission.guard';
import { ContractIdPipe } from './contract-id.pipe';
import { SendContractDto } from './dto/send-contract.dto';
import { ContractSendService, type EndResult } from './contract-send.service';
import { SendContractResponseDto } from './dto/send-contract.response.dto';

// 근로계약 재발송(WHALEERP-136). 보내기는 저장할 때 곧바로 한다(2026-10-19 재영) — 따로 부르는 것은 재발송뿐이다.
// 근로계약 관리(ContractsController)와 같은 경로 · 권한이다 — 재발송은 기존 계약을 바꾸므로 수정 권한(WHALEERP-592).
@ApiBearerAuth()
@ApiForbiddenResponse({
  description:
    '근로계약 관리 수정 권한 없음 · 직원 앱 토큰 · 사용 중인 관리자 계정이 아님',
})
@UserTypes('admin')
@Controller('contracts')
export class ContractSendController {
  constructor(private readonly sender: ContractSendService) {}

  /**
   * 재발송 — 발송 대기 · 서명 대기 · 거부 · 만료(WHALEERP-153)에서 새 서명 기한(30일)으로 다시 보낸다. 가입 전 · 계정 없는 번호는 가입 초대 알림톡을 새
   * 초대 코드로(상태 그대로, 앞서 나간 초대 코드는 무효), 가입한 직원은 앱 알림(근로계약서 발송 알림)으로 보낸다 — 발송 대기였으면
   * 서명 대기로 넘긴다(WHALEERP-611). 가입한 직원의 알림은 알림함 알림이고(앱 푸시는 #261 전까지 나가지 않는다), 알림 템플릿을
   * 쓸 수 없거나 탈퇴 계정이면 알림 없이 기한만 새로 잡는다. 계정은 있고 이 점포에 가입하지 않은 번호(소속 추가 확인 · 복귀
   * 확인)는 소속 추가 확인 요청 알림톡 · 메일을 새로 보내고 발송 대기로 둔다 — 날인 기한은 직원이 수락한 때부터라 응답의 기한은
   * null 이다(WHALEERP-130).
   */
  @Post(':contractId/send')
  @MenuPermission('update')
  @HttpCode(200)
  // 본문은 비워도 된다(옛 화면) — 생성 문서가 필수로 표시하지 않게(셀프 code-review)
  @ApiBody({ type: SendContractDto, required: false })
  @ApiOkResponse({
    type: SendContractResponseDto,
    description:
      'status — 가입 초대는 그대로 PENDING_SEND · PENDING_SIGNATURE, 가입한 직원은 PENDING_SIGNATURE, 소속 추가 확인 요청은 PENDING_SEND(signDeadlineAt null — 수락부터 30일). 거부 · 만료(WHALEERP-153)는 가입한 직원이면 PENDING_SIGNATURE, 그 밖에는 PENDING_SEND 로 되살린다. 가입한 직원은 알림함 알림(앱 푸시는 #261 전까지 나가지 않음) — 알림 템플릿을 쓸 수 없거나 탈퇴 계정이면 알림 없이 기한만 새로',
  })
  @ApiNotFoundResponse({ description: '없는 계약 · 업무 범위 밖' })
  @ApiConflictResponse({
    description:
      'CONTRACT_STATUS_CONFLICT(발송 대기 · 서명 대기 · 거부 · 만료가 아님, 또는 본문 expectedStatus · expectedSentAt 이 지금 계약과 다름 — 그사이 거부 · 만료되었거나 다른 탭에서 먼저 보냄) · REOPEN_BLOCKED(거부 · 만료를 되살릴 수 없음 — 퇴직 · 퇴직일 있음, 폐점 · 삭제 점포, 같은 점포 · 번호의 다른 진행 중 계약, 계약 기간이 끝남, 기간이 겹치거나 더 늦게 시작한 다른 체결 완료, 같은 직전 계약의 다른 재계약. message 에 까닭) · WORK_TIME_OVERLAP(거부 · 만료를 되살리면 다른 점포 근무 시간과 겹침) · SEND_PHONE_NOT_MOBILE(휴대폰 번호가 아님) · 코드 없음 「이 점포에 이미 재직 중인 직원입니다.」(가입 전 레코드인데 그 번호의 계정이 이 점포에 재직 중) · 다른 요청이 먼저 고침',
  })
  @ApiBadGatewayResponse({
    description:
      '가입 초대 · 소속 추가 확인 요청 알림톡일 때만 — SEND_FAILED(나가지 않음 — 거절 · 토큰 단계 · 요청 전 오류, 되돌렸고 다시 보낼 수 있음, 본문 contractId · status) · SEND_UNCONFIRMED(접수 여부 모름 또는 되돌리기 실패 — 상세를 다시 읽을 것). 소속 추가 확인 요청 메일 실패는 오류가 아니다',
  })
  @ApiServiceUnavailableResponse({
    description:
      '가입 초대 · 소속 추가 확인 요청 알림톡일 때만 — 직원 앱 주소(STAFF_APP_URL)가 없음 · 대체 문자 발신번호(BIZPPURIO_SMS_FROM)가 없음 · 그 알림톡 템플릿이 없거나 꺼짐',
  })
  send(
    @Param('contractId', ContractIdPipe) contractId: number,
    @Body() dto: SendContractDto,
    @CurrentUser() user: AuthUser,
  ): Promise<SendContractResponseDto> {
    return this.sender.send(user.id, contractId, new Date(), {
      status: dto.expectedStatus,
      sentAt: dto.expectedSentAt,
    });
  }

  /**
   * 발송 대기 계약 종료(WHALEERP-327). 채용을 접을 때 계약을 종료로 닫고 나간 초대(코드 · 링크)를 무효로 한다. 행은 남고 상태
   * 이력에 남는다. 기존 계약을 바꾸므로 수정 권한이다.
   */
  @Post(':contractId/end')
  @MenuPermission('update')
  @HttpCode(200)
  @ApiOkResponse({ description: '{ contractId, status: ENDED }' })
  @ApiNotFoundResponse({ description: '없는 계약 · 업무 범위 밖' })
  @ApiConflictResponse({
    description:
      'CONTRACT_STATUS_CONFLICT(발송 대기가 아님 — 지금 상태를 싣는다) · 다른 요청이 먼저 고침',
  })
  end(
    @Param('contractId', ContractIdPipe) contractId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<EndResult> {
    return this.sender.end(user.id, contractId);
  }
}
