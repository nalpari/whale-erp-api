import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseEnumPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiParam,
} from '@nestjs/swagger';
import { PreferenceCategory } from '@prisma/client';
import { CurrentUser, UserTypes } from '../auth/auth.decorators';
// 데코레이터가 붙은 시그니처에서만 쓰는 타입이라 import type 이어야 한다.
import type { AuthUser } from '../auth/auth.types';
import {
  MyNotificationItemDto,
  MyNotificationListResponseDto,
  MyNotificationPreferenceDto,
  MyNotificationPreferenceListResponseDto,
  UpdateMyNotificationPreferenceDto,
} from './dto/my-notification.dto';
import { NotificationReadAllResponseDto } from './dto/notification-item.response.dto';
import { NotificationListQueryDto } from './dto/notification-list.query.dto';
import { MyNotificationsService } from './my-notifications.service';
import { NotificationIdPipe } from './notification-id.pipe';

/**
 * 직원 근무 앱 알림함(WHALEERP-265). 화면 위쪽 종에서 들어간다(NOTI-5). 모든 근무지의 알림, 만든 지 14일 안의 것만(NOTI-3).
 * 읽음은 한 줄씩 바꾸고 「모두 읽음」도 있다(NOTI-7).
 */
@ApiBearerAuth()
@ApiForbiddenResponse({ description: '관리자 토큰' })
@UserTypes('account')
@Controller('me/notifications')
export class MyNotificationsController {
  constructor(private readonly notifications: MyNotificationsService) {}

  /** 목록 · 미확인 건수 · 줄마다 눌러 열 곳. 수신 설정으로 앱 푸시를 끈 알림도 보인다 */
  @Get()
  @ApiOkResponse({ type: MyNotificationListResponseDto })
  @ApiBadRequestResponse({ description: '쿼리 형식 오류' })
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: NotificationListQueryDto,
  ): Promise<MyNotificationListResponseDto> {
    return this.notifications.list(user.id, query);
  }

  /** 14일 안의 미확인을 모두 읽음 */
  @Post('read-all')
  @HttpCode(200)
  @ApiOkResponse({ type: NotificationReadAllResponseDto })
  readAll(
    @CurrentUser() user: AuthUser,
  ): Promise<NotificationReadAllResponseDto> {
    return this.notifications.readAll(user.id);
  }

  /** 읽음 — 알림을 눌러 관련 화면으로 갈 때도 부른다 */
  @Post(':id/read')
  @HttpCode(200)
  @ApiOkResponse({ type: MyNotificationItemDto })
  @ApiNotFoundResponse({
    description: '내 알림이 아니거나 지웠거나 14일이 지났다',
  })
  read(
    @CurrentUser() user: AuthUser,
    @Param('id', NotificationIdPipe) id: number,
  ): Promise<MyNotificationItemDto> {
    return this.notifications.mark(user.id, id, true);
  }

  /** 안 읽음으로 되돌리기 */
  @Post(':id/unread')
  @HttpCode(200)
  @ApiOkResponse({ type: MyNotificationItemDto })
  @ApiNotFoundResponse({
    description: '내 알림이 아니거나 지웠거나 14일이 지났다',
  })
  unread(
    @CurrentUser() user: AuthUser,
    @Param('id', NotificationIdPipe) id: number,
  ): Promise<MyNotificationItemDto> {
    return this.notifications.mark(user.id, id, false);
  }
}

/**
 * 직원 알림 수신 설정(WHALEERP-268). 수신 설정 묶음마다 앱 푸시를 켜고 끈다 — 네 묶음 모두 끌 수 있다(NOTI-8). 꺼도 알림함에는
 * 남는다. 관리자는 바꾸지 못한다(관리자 토큰 403).
 */
@ApiBearerAuth()
@ApiForbiddenResponse({ description: '관리자 토큰' })
@UserTypes('account')
@Controller('me/notification-preferences')
export class MyNotificationPreferencesController {
  constructor(private readonly notifications: MyNotificationsService) {}

  /** 네 묶음(근로계약서 · 근무스케줄 · TO-DO · 급여명세서). 바꾼 적 없으면 켜짐 */
  @Get()
  @ApiOkResponse({ type: MyNotificationPreferenceListResponseDto })
  list(
    @CurrentUser() user: AuthUser,
  ): Promise<MyNotificationPreferenceListResponseDto> {
    return this.notifications.preferences(user.id);
  }

  /** 한 묶음 켜고 끄기. 그 뒤에 생기는 알림부터 든다 */
  @Put(':category')
  @ApiParam({
    name: 'category',
    enum: PreferenceCategory,
    enumName: 'PreferenceCategory',
  })
  @ApiOkResponse({ type: MyNotificationPreferenceDto })
  @ApiBadRequestResponse({ description: '모르는 묶음 · isEnabled 형식 오류' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('category', new ParseEnumPipe(PreferenceCategory))
    category: PreferenceCategory,
    @Body() body: UpdateMyNotificationPreferenceDto,
  ): Promise<MyNotificationPreferenceDto> {
    return this.notifications.setPreference(user.id, category, body.isEnabled);
  }
}
