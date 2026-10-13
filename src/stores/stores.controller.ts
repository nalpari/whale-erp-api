import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
} from '@nestjs/swagger';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import { ListStoresQueryDto } from './dto/list-stores-query.dto';
import { StoreListResponseDto } from './dto/store.response.dto';
import { StoresService } from './stores.service';

// 점포는 1팀 영역이다. 3팀 화면(근로계약서 근무지)이 고를 목록만 읽는다 — 1팀 점포 관리 API 가 생기면 그쪽으로 합친다.
// 관리자의 업무 범위(BP · 점포)로 거른다 — StoresService.
@ApiBearerAuth()
@UserTypes('admin')
@Controller('stores')
export class StoresController {
  constructor(private readonly stores: StoresService) {}

  @Get()
  @ApiOkResponse({ type: StoreListResponseDto })
  @ApiForbiddenResponse({
    description: '직원 앱 토큰이거나 사용 중인 관리자 계정이 아님',
  })
  list(
    @Query() query: ListStoresQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<StoreListResponseDto> {
    return this.stores.list(user.id, query);
  }
}
