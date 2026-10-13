import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
} from '@nestjs/swagger';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import {
  ContractDetailDto,
  ContractListResponseDto,
} from './dto/contract.response.dto';
import {
  CreateContractDto,
  CreatedContractResponseDto,
} from './dto/create-contract.dto';
import { ListContractsQueryDto } from './dto/list-contracts-query.dto';
import { ContractIdPipe } from './contract-id.pipe';
import { ContractsService } from './contracts.service';

// 관리자 웹의 근로계약 관리. 관리자의 업무 범위(BP · 점포) 밖 계약은 없는 것과 같다(404) — ContractsService.
@ApiBearerAuth()
@ApiForbiddenResponse({
  description: '직원 앱 토큰이거나 사용 중인 관리자 계정이 아님(목록)',
})
@UserTypes('admin')
@Controller('contracts')
export class ContractsController {
  constructor(private readonly contracts: ContractsService) {}

  @Get()
  @ApiOkResponse({ type: ContractListResponseDto })
  list(
    @Query() query: ListContractsQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ContractListResponseDto> {
    return this.contracts.list(user.id, query);
  }

  /** 근로계약서 초안 저장 — 미가입 직원 레코드와 발송 대기 계약을 만든다 */
  @Post()
  @ApiCreatedResponse({ type: CreatedContractResponseDto })
  @ApiBadRequestResponse({ description: '입력 오류 · 만 19세 미만' })
  @ApiNotFoundResponse({
    description: '근무지 점포가 없거나 폐점이거나 업무 범위 밖',
  })
  @ApiConflictResponse({
    description:
      '이 점포에 같은 번호로 재직 중 · CONTRACT_IN_PROGRESS(같은 점포 진행 중 계약 — contracts 목록, replaceContractIds 로 대체) · WORK_TIME_OVERLAP(다른 점포 근무 시간 겹침, 초안 저장만) · 대체할 계약을 다른 요청이 먼저 고침',
  })
  create(
    @Body() body: CreateContractDto,
    @CurrentUser() user: AuthUser,
  ): Promise<CreatedContractResponseDto> {
    return this.contracts.create(body, user.id);
  }

  /** 작성 화면을 다시 채울 값 — 임시저장 이어 쓰기 */
  @Get(':contractId')
  @ApiOkResponse({ type: ContractDetailDto })
  @ApiNotFoundResponse({ description: '없는 계약 · 업무 범위 밖' })
  findOne(
    @Param('contractId', ContractIdPipe) contractId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<ContractDetailDto> {
    return this.contracts.findOne(user.id, contractId);
  }

  /** 임시저장 이어 쓰기. 폼 전체를 다시 보낸다. isTemporarySave 를 빼면 초안 저장(발송 대기)으로 넘어간다 */
  @Put(':contractId')
  @ApiOkResponse({ type: CreatedContractResponseDto })
  @ApiBadRequestResponse({ description: '입력 오류 · 만 19세 미만' })
  @ApiNotFoundResponse({
    description: '없는 계약 · 근무지 점포가 없거나 폐점 · 업무 범위 밖',
  })
  @ApiConflictResponse({
    description:
      '임시저장이 아님 · 이 점포에 같은 번호로 재직 중 · CONTRACT_IN_PROGRESS · WORK_TIME_OVERLAP · 다른 요청이 먼저 고침',
  })
  update(
    @Param('contractId', ContractIdPipe) contractId: number,
    @Body() body: CreateContractDto,
    @CurrentUser() user: AuthUser,
  ): Promise<CreatedContractResponseDto> {
    return this.contracts.update(user.id, contractId, body);
  }

  /** 임시저장 삭제. 계약 · 근무 요일 · 당사자 · 이력과 그 계약에만 쓰인 초안 직원 레코드를 지운다 */
  @Delete(':contractId')
  @HttpCode(204)
  @ApiNoContentResponse({ description: '지웠다' })
  @ApiNotFoundResponse({ description: '없는 계약 · 업무 범위 밖' })
  @ApiConflictResponse({ description: '임시저장이 아님' })
  remove(
    @Param('contractId', ContractIdPipe) contractId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    return this.contracts.remove(user.id, contractId);
  }
}
