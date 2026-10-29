import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiServiceUnavailableResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { DownloadUrlResponseDto } from '../storage/dto/download-url.response.dto';
import { ContractIdPipe } from './contract-id.pipe';
import { MyContractDocumentsService } from './my-contract-documents.service';

// 직원 앱의 근로계약 파일 내려받기(WHALEERP-146 · 149). 조회(610)와 같은 경로 · 같은 「내 계약」이고, 날인(145)의
// 계정당 요청 제한은 걸지 않는다 — 조회 컨트롤러와 같은 이유.
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: '토큰 없음 · 접속 종료 · 탈퇴 계정' })
@ApiForbiddenResponse({ description: '관리자 토큰' })
@UserTypes('account')
@Controller('me/contracts')
export class MyContractDocumentsController {
  constructor(private readonly documents: MyContractDocumentsService) {}

  /** 내 근로계약 파일 내려받기 주소(300초) — 상세 documents 의 파일. 받으면 원래 파일 이름으로 저장된다 */
  @Get(':contractId/documents/:contractDocumentId/download-url')
  @ApiOkResponse({ type: DownloadUrlResponseDto })
  @ApiNotFoundResponse({
    description:
      '내 계약이 아님(상세와 같은 본문) · 그 계약의 파일이 아님 · 상세 documents 에 없는 파일(직원 필기 서명)',
  })
  @ApiConflictResponse({
    description:
      'CONTRACT_STATUS_CONFLICT — 처리 완료본(SIGNED_COPY)인데 체결된 계약이 아님(서명 대기 · 수정 요청 · 거부 · 만료, 체결 완료를 거치지 않은 종료). 본문 status 에 지금 상태',
  })
  @ApiServiceUnavailableResponse({
    description: '첨부파일 저장소가 설정되지 않음',
  })
  downloadUrl(
    @Param('contractId', ContractIdPipe) contractId: number,
    @Param('contractDocumentId', ContractIdPipe) contractDocumentId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<DownloadUrlResponseDto> {
    return this.documents.downloadUrl(user.id, contractId, contractDocumentId);
  }
}
