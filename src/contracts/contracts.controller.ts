import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
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

// 관리자 웹의 근로계약 관리. 관리자의 업무 범위(BP · 점포)로 거르는 것은 1팀 로그인이 생긴 뒤에 붙인다.
@ApiBearerAuth()
@UserTypes('admin')
@Controller('contracts')
export class ContractsController {
  constructor(private readonly contracts: ContractsService) {}

  @Get()
  @ApiOkResponse({ type: ContractListResponseDto })
  list(
    @Query() query: ListContractsQueryDto,
  ): Promise<ContractListResponseDto> {
    return this.contracts.list(query);
  }

  /** 근로계약서 초안 저장 — 미가입 직원 레코드와 발송 대기 계약을 만든다 */
  @Post()
  @ApiCreatedResponse({ type: CreatedContractResponseDto })
  @ApiBadRequestResponse({ description: '입력 오류 · 만 19세 미만' })
  @ApiNotFoundResponse({ description: '근무지 점포가 없거나 폐점' })
  @ApiConflictResponse({ description: '이 점포에 같은 번호로 재직 중' })
  create(
    @Body() body: CreateContractDto,
    @CurrentUser() user: AuthUser,
  ): Promise<CreatedContractResponseDto> {
    return this.contracts.create(body, user.id);
  }

  /** 작성 화면을 다시 채울 값 — 임시저장 이어 쓰기 */
  @Get(':contractId')
  @ApiOkResponse({ type: ContractDetailDto })
  @ApiNotFoundResponse({ description: '없는 계약' })
  findOne(
    @Param('contractId', ContractIdPipe) contractId: number,
  ): Promise<ContractDetailDto> {
    return this.contracts.findOne(contractId);
  }

  /** 임시저장 이어 쓰기. 폼 전체를 다시 보낸다. isTemporarySave 를 빼면 초안 저장(발송 대기)으로 넘어간다 */
  @Put(':contractId')
  @ApiOkResponse({ type: CreatedContractResponseDto })
  @ApiBadRequestResponse({ description: '입력 오류 · 만 19세 미만' })
  @ApiNotFoundResponse({ description: '없는 계약 · 근무지 점포가 없거나 폐점' })
  @ApiConflictResponse({
    description: '임시저장이 아님 · 이 점포에 같은 번호로 재직 중',
  })
  update(
    @Param('contractId', ContractIdPipe) contractId: number,
    @Body() body: CreateContractDto,
  ): Promise<CreatedContractResponseDto> {
    return this.contracts.update(contractId, body);
  }
}
