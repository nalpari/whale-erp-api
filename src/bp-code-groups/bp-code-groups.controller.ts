import {
  Body,
  Controller,
  Delete,
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
import { DeleteCodeItemsDto } from '../code-groups/dto/delete-code-items.dto';
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
 * create, 수정(PUT)은 update, 삭제(DELETE)는 delete 다. 등록과 수정은 경로가 따로다 — 플랫폼 공통코드 관리와 같이, 화면이 새 행과 수정분을
 * 함께 저장하면 두 번 부른다(각자 한 트랜잭션이라 둘 사이의 원자성은 없다).
 *
 * 그룹은 조회만 한다. 플랫폼 사용자(PM · PA)는 BP 를 골라 조회만 하고 등록 · 수정 · 삭제는 403 이다.
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description:
    '쓸 수 없는 계정 · 메뉴 권한 없음 · BP · 가맹 사용자의 다른 BP 헤더 · 플랫폼 사용자의 등록 · 수정 · 삭제',
})
@ApiBadRequestResponse({
  description:
    '본문 · 쿼리 검증 실패 · (조회) 플랫폼 사용자의 X-Bp-Code-Id 누락 — 등록 · 수정 · 삭제는 그 전에 403',
})
@ApiNotFoundResponse({
  description:
    '플랫폼 사용자의 X-Bp-Code-Id 가 없는 · 지운 · 플랫폼 BP 이거나 형식이 틀림(가드) — `:groupCode` 경로는 그룹 404(없음 · 지움 · 사용중지 · 플랫폼고정 — BP 화면에 보이지 않는 그룹)도 있다',
})
@UserTypes('admin')
@Controller('bp-code-groups')
export class BpCodeGroupsController {
  constructor(private readonly codes: BpCodeGroupsService) {}

  /** 그룹 목록 — 사용 중인 플랫폼제공 그룹(적용 여부와 관계없이), 표시 순서대로. 플랫폼고정 · 사용중지 그룹은 items · total 에서 빠진다. */
  @Get()
  @MenuPermission('read')
  async listGroups(
    @TargetBp() bp: TargetBpContext,
    @Query() query: ListBpCodeGroupsDto,
  ): Promise<BpCodeGroupListResponseDto> {
    return this.codes.listGroups(bp, query);
  }

  /** 고른 플랫폼제공 그룹의 상세 코드 — 이 BP 의 행(BP전용 포함). 플랫폼고정 · 사용중지 그룹은 404. */
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
      '같은 그룹의 살아 있는 플랫폼 원본(「플랫폼이 등록한…」)이나 이 BP 의 살아 있는 행(「이미 있는…」)과 겹친 코드 · 요청 안에서 겹친 코드 · 확인 뒤 다른 관리자가 같은 코드를 먼저 등록하거나 되살림 — 이 BP 의 지운 행과 같은 코드는 BP전용으로 되살린다',
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

  /** 상세 코드 수정 — 이 BP 의 행 여러 개를 한 번에. 하나라도 막히거나 그 사이 고쳐졌으면(행마다 updatedAt) 아무것도 고치지 않는다. */
  @Put(':groupCode/items')
  @MenuPermission('update')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNotFoundResponse({
    description:
      '대상 BP(가드) · 그룹(없음 · 지움 · 사용중지 · 플랫폼고정) 404, 그리고 이 BP 에 없는 상세 코드(플랫폼 원본에만 있는 코드 포함)',
  })
  @ApiConflictResponse({
    description:
      '한 요청에 같은 코드가 두 번 · 목록에서 읽은 뒤 다른 관리자가 먼저 수정(「다른 관리자가 먼저 수정했습니다…」) · 먼저 지운 코드(「다른 관리자가 먼저 지운…저장해 주세요.」)',
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

  /** 상세 코드 삭제(논리) — 이 BP 의 행(BP전용 · 복사된 플랫폼제공) 여러 개를 한 번에. 하나라도 막히면 아무것도 지우지 않는다. */
  @Delete(':groupCode/items')
  @MenuPermission('delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNotFoundResponse({
    description:
      '대상 BP(가드) · 그룹(없음 · 지움 · 사용중지 · 플랫폼고정) 404, 그리고 이 BP 에 없는 상세 코드',
  })
  @ApiConflictResponse({
    description:
      '한 요청에 같은 코드가 두 번 · 확인 뒤 다른 관리자가 먼저 지움',
  })
  async deleteItems(
    @CurrentUser() user: AuthUser,
    @TargetBp() bp: TargetBpContext,
    @Param('groupCode') groupCode: string,
    @Body() body: DeleteCodeItemsDto,
  ): Promise<void> {
    await this.codes.deleteItems(
      user.id,
      bp,
      groupCodeOf(groupCode),
      body.itemCodes,
    );
  }
}
