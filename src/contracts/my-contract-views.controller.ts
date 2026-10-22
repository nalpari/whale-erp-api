import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { ContractIdPipe } from './contract-id.pipe';
import {
  MyContractDetailDto,
  MyContractListResponseDto,
} from './dto/my-contract-view.dto';
import { MyContractViewsService } from './my-contract-views.service';

// 직원 앱의 근로계약 조회(WHALEERP-610). 날인 · 거부 · 수정 요청(145)과 경로는 같고 컨트롤러를 나눈다 — 그쪽의
// 계정당 요청 제한(10분 20번)을 조회에 걸지 않으려고.
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: '토큰 없음 · 접속 종료 · 탈퇴 계정' })
@ApiForbiddenResponse({ description: '관리자 토큰' })
@UserTypes('account')
@Controller('me/contracts')
export class MyContractViewsController {
  constructor(private readonly contracts: MyContractViewsService) {}

  /** 내 근로계약 목록 — 서명 대기 이후(임시저장 · 발송 대기 제외). 소속 확인 대기 계약은 없다 */
  @Get()
  @ApiOkResponse({ type: MyContractListResponseDto })
  list(@CurrentUser() user: AuthUser): Promise<MyContractListResponseDto> {
    return this.contracts.list(user.id);
  }

  /** 내 근로계약 상세 — 계약서에 그릴 값 · 사용자 칸 · 본인 대조 미리보기(날인할 수 있는지 · 다른 항목) */
  @Get(':contractId')
  @ApiOkResponse({ type: MyContractDetailDto })
  @ApiNotFoundResponse({
    description:
      '내 계약이 아님 — 없는 id · 남의 계약 · 임시저장 · 발송 대기 · 소속 확인 대기 계약(후보 계정만). 모두 같은 본문',
  })
  findOne(
    @Param('contractId', ContractIdPipe) contractId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<MyContractDetailDto> {
    return this.contracts.findOne(user.id, contractId);
  }
}
