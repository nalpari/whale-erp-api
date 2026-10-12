import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse } from '@nestjs/swagger';
import { UserTypes } from '../auth/auth.decorators';
import { ListStoresQueryDto } from './dto/list-stores-query.dto';
import { StoreListResponseDto } from './dto/store.response.dto';
import { StoresService } from './stores.service';

// 점포는 1팀 영역이다. 3팀 화면(근로계약서 근무지)이 고를 목록만 읽는다 — 1팀 점포 관리 API 가 생기면 그쪽으로 합친다.
// 관리자의 업무 범위(BP · 점포)로 거르는 것은 로그인이 생긴 뒤에 붙인다.
@ApiBearerAuth()
@UserTypes('admin')
@Controller('stores')
export class StoresController {
  constructor(private readonly stores: StoresService) {}

  @Get()
  @ApiOkResponse({ type: StoreListResponseDto })
  list(@Query() query: ListStoresQueryDto): Promise<StoreListResponseDto> {
    return this.stores.list(query);
  }
}
