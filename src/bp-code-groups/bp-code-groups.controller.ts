import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
} from '@nestjs/swagger';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import {
  MenuPermission,
  TargetBp,
  type TargetBpContext,
} from '../auth/menu-permission.guard';
import { groupCodeOf } from '../code-groups/code-groups.controller';
import { CreateCodeItemsDto } from '../code-groups/dto/create-code-items.dto';
import { UpdateCodeItemsDto } from '../code-groups/dto/update-code-items.dto';
import { BpCodeGroupsService } from './bp-code-groups.service';
import {
  BpCodeGroupListResponseDto,
  BpCodeItemListResponseDto,
} from './dto/bp-code-group.response.dto';
import { ListBpCodeGroupsDto } from './dto/list-bp-code-groups.dto';

/**
 * BP 공통코드 관리 (S-FHVSAV). 관리자 웹 메뉴(`/bp-code-groups`, 현재 MN000014)의 권한으로 경로마다
 * @MenuPermission 이 판정하고, 대상 BP 는 X-Bp-Code-Id → `@TargetBp()` 로 받는다. 조회는 read, 상세 코드 등록(POST)은
 * create, 수정(PUT)은 update 다. 등록과 수정은 경로가 따로다 — 플랫폼 공통코드 관리와 같이, 화면이 새 행과 수정분을
 * 함께 저장하면 두 번 부른다(각자 한 트랜잭션이라 둘 사이의 원자성은 없다).
 *
 * 그룹은 조회만 한다. 플랫폼 사용자(PM · PA)는 BP 를 골라 조회만 하고 등록 · 수정은 403 이다.
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description:
    '쓸 수 없는 계정 · 메뉴 권한 없음 · BP · 가맹 사용자의 다른 BP 헤더 · 플랫폼 사용자의 등록 · 수정',
})
@ApiBadRequestResponse({ description: '플랫폼 사용자의 X-Bp-Code-Id 누락' })
@ApiNotFoundResponse({
  description:
    '플랫폼 사용자의 X-Bp-Code-Id 가 없는 · 지운 · 플랫폼 BP 이거나 형식이 틀림(가드) — `:groupCode` 경로는 그룹 404 도 있다',
})
@UserTypes('admin')
@Controller('bp-code-groups')
export class BpCodeGroupsController {
  constructor(private readonly codes: BpCodeGroupsService) {}

  /** 그룹 목록 — 플랫폼고정과 BP 에 적용된 플랫폼제공 그룹(사용중지 포함), 표시 순서대로. */
  @Get()
  @MenuPermission('read')
  async listGroups(
    @TargetBp() bp: TargetBpContext,
    @Query() query: ListBpCodeGroupsDto,
  ): Promise<BpCodeGroupListResponseDto> {
    return this.codes.listGroups(bp, query);
  }

  /** 고른 그룹의 상세 코드. 플랫폼고정은 플랫폼 원본, 플랫폼제공은 이 BP 의 행(BP전용 포함). */
  @Get(':groupCode/items')
  @MenuPermission('read')
  async listItems(
    @TargetBp() bp: TargetBpContext,
    @Param('groupCode') groupCode: string,
  ): Promise<BpCodeItemListResponseDto> {
    return this.codes.listItems(bp, groupCodeOf(groupCode));
  }

  /** 상세 코드 등록 — BP전용 코드 여러 개를 한 번에. 하나라도 막히면 아무것도 생기지 않는다. */
  @Post(':groupCode/items')
  @MenuPermission('create')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiConflictResponse({
    description:
      '플랫폼고정 · 사용중지 그룹 · 같은 그룹의 플랫폼 원본이나 이 BP 의 행(지운 것 포함)과 겹친 코드 · 요청 안에서 겹친 코드',
  })
  async createItems(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Param('groupCode') groupCode: string,
    @Body() body: CreateCodeItemsDto,
  ): Promise<void> {
    await this.codes.createItems(
      user.id,
      bp,
      groupCodeOf(groupCode),
      body.items,
    );
  }

  /** 상세 코드 수정 — 이 BP 의 행 여러 개를 한 번에. 하나라도 막히면 아무것도 고치지 않는다. */
  @Put(':groupCode/items')
  @MenuPermission('update')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiConflictResponse({
    description:
      '플랫폼고정 · 사용중지 그룹 · 플랫폼이 사용 중지한 코드를 사용으로 켬 · 한 요청에 같은 코드가 두 번',
  })
  async updateItems(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Param('groupCode') groupCode: string,
    @Body() body: UpdateCodeItemsDto,
  ): Promise<void> {
    await this.codes.updateItems(
      user.id,
      bp,
      groupCodeOf(groupCode),
      body.items,
    );
  }
}
