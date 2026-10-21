import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
} from '@nestjs/swagger';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import { MenuPermission } from '../auth/menu-permission.guard';
import { CODE_PATTERN, toUpperCode } from './code-format';
import { CodeGroupsService } from './code-groups.service';
import {
  BpApplicationResponseDto,
  CodeGroupListResponseDto,
  CodeItemListResponseDto,
} from './dto/code-group.response.dto';
import { CreateCodeGroupsDto } from './dto/create-code-groups.dto';
import { CreateCodeItemsDto } from './dto/create-code-items.dto';
import { ListCodeGroupsDto } from './dto/list-code-groups.dto';
import { UpdateCodeGroupsDto } from './dto/update-code-groups.dto';
import { UpdateCodeItemsDto } from './dto/update-code-items.dto';

/**
 * 플랫폼 공통코드 관리 (S-UQPNIH). 관리자 웹 메뉴 MN000216 의 권한을 가진 플랫폼 관리자(플랫폼 BP 의 PM · PA)만
 * 쓴다. 조회는 read, 등록(POST)은 create, 수정(PUT) · BP 적용은 update 로 경로마다 @MenuPermission(platformOnly)
 * 가 판정한다. 등록과 수정은 경로가 따로다 — 새 행과 수정분을 함께 보내는 저장은 없고, 화면이 둘 다 있으면
 * 두 번 부른다(각자 한 트랜잭션이라 둘 사이의 원자성은 없다).
 */
@ApiBearerAuth()
@ApiForbiddenResponse({
  description: '쓸 수 없는 계정 · 메뉴 권한 없음 · 플랫폼 관리자가 아님',
})
@UserTypes('admin')
@Controller('code-groups')
export class CodeGroupsController {
  constructor(private readonly codes: CodeGroupsService) {}

  /** 공통코드 그룹 목록. 플랫폼고정 · 플랫폼제공 그룹을 표시 순서대로. */
  @Get()
  @MenuPermission('read', { platformOnly: true })
  async listGroups(
    @Query() query: ListCodeGroupsDto,
  ): Promise<CodeGroupListResponseDto> {
    return this.codes.listGroups(query);
  }

  /** 그룹 등록. 새 그룹 여러 개를 한 번에 — 하나라도 막히면 아무것도 생기지 않는다. */
  @Post()
  @MenuPermission('create', { platformOnly: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiConflictResponse({
    description:
      '이미 있는(지운 것 포함) 그룹 코드 · 요청 안에서 겹친 그룹 코드',
  })
  async createGroups(
    @CurrentUser() user: AuthUser,
    @Body() body: CreateCodeGroupsDto,
  ): Promise<void> {
    await this.codes.createGroups(user.id, body.items);
  }

  /** 그룹 수정. 기존 그룹 여러 개를 한 번에 — 하나라도 없으면 아무것도 고치지 않는다. */
  @Put()
  @MenuPermission('update', { platformOnly: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNotFoundResponse({ description: '고칠 그룹이 없음' })
  @ApiConflictResponse({ description: '한 요청에 같은 그룹 코드가 두 번' })
  async updateGroups(
    @CurrentUser() user: AuthUser,
    @Body() body: UpdateCodeGroupsDto,
  ): Promise<void> {
    await this.codes.updateGroups(user.id, body.items);
  }

  /** 고른 그룹의 상세 코드(플랫폼 원본). BP전용 코드는 나오지 않는다. */
  @Get(':groupCode/items')
  @MenuPermission('read', { platformOnly: true })
  @ApiNotFoundResponse({ description: '없는 그룹' })
  async listItems(
    @Param('groupCode') groupCode: string,
  ): Promise<CodeItemListResponseDto> {
    return this.codes.listItems(groupCodeOf(groupCode));
  }

  /** 상세 코드 등록. 새 코드 여러 개를 한 번에 — 하나라도 막히면 아무것도 생기지 않는다. */
  @Post(':groupCode/items')
  @MenuPermission('create', { platformOnly: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNotFoundResponse({ description: '없는 그룹' })
  @ApiConflictResponse({
    description:
      '이 그룹에 이미 있는(BP별 · BP전용 · 지운 행 포함) 상세 코드 · 요청 안에서 겹친 상세 코드',
  })
  async createItems(
    @CurrentUser() user: AuthUser,
    @Param('groupCode') groupCode: string,
    @Body() body: CreateCodeItemsDto,
  ): Promise<void> {
    await this.codes.createItems(user.id, groupCodeOf(groupCode), body.items);
  }

  /** 상세 코드 수정. 기존 코드 여러 개를 한 번에 — 하나라도 없으면 아무것도 고치지 않는다. */
  @Put(':groupCode/items')
  @MenuPermission('update', { platformOnly: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNotFoundResponse({ description: '없는 그룹 · 고칠 상세 코드가 없음' })
  @ApiConflictResponse({ description: '한 요청에 같은 상세 코드가 두 번' })
  async updateItems(
    @CurrentUser() user: AuthUser,
    @Param('groupCode') groupCode: string,
    @Body() body: UpdateCodeItemsDto,
  ): Promise<void> {
    await this.codes.updateItems(user.id, groupCodeOf(groupCode), body.items);
  }

  /**
   * BP에 적용. 플랫폼제공 그룹만. 각 BP 에 아직 없는 행만 넣는다 — 다시 눌러도 된다.
   * 되돌릴 수 없지만 행을 지우지 않고 그룹의 적용 여부를 바꾸는 동작이라 수정 권한으로 본다.
   */
  @Post(':groupCode/bp-application')
  @MenuPermission('update', { platformOnly: true })
  @HttpCode(HttpStatus.OK)
  @ApiNotFoundResponse({ description: '없는 그룹' })
  @ApiConflictResponse({
    description:
      '플랫폼제공 그룹이 아님 · 상세 코드가 없음 · 사용 중인 고객 BP 가 없음',
  })
  async applyToBps(
    @CurrentUser() user: AuthUser,
    @Param('groupCode') groupCode: string,
  ): Promise<BpApplicationResponseDto> {
    return this.codes.applyToBps(user.id, groupCodeOf(groupCode));
  }
}

/**
 * 경로의 그룹 코드도 본문과 같이 앞뒤 공백을 지우고 대문자로 받는다. 그래도 형식이 틀리면 있을 수 없는
 * 그룹이다 — DB 에 묻지 않고 404.
 */
function groupCodeOf(raw: string): string {
  const code = toUpperCode({ value: raw }) as string;
  if (!CODE_PATTERN.test(code))
    throw new NotFoundException('공통코드 그룹을 찾을 수 없습니다');
  return code;
}
