import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { UserTypes } from '../auth/auth.decorators';
import { CreateItemDto } from './dto/create-item.dto';
import { CreateStockMovementDto } from './dto/create-stock-movement.dto';
import { ItemResponseDto, MovementResponseDto } from './dto/item.response.dto';
import { ListItemsQueryDto } from './dto/list-items-query.dto';
import { UpdateItemDto } from './dto/update-item.dto';
import { ItemsService } from './items.service';

// 품목 마스터는 직원용이다. 전역 가드는 인증 여부만 보므로, 이 표시가 없으면
// 고객 토큰으로도 조회·수정·삭제가 열린다.
@UserTypes('staff')
@ApiBearerAuth()
@Controller('items')
export class ItemsController {
  constructor(private readonly items: ItemsService) {}

  @Get()
  findAll(@Query() query: ListItemsQueryDto): Promise<ItemResponseDto[]> {
    return this.items.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string): Promise<ItemResponseDto> {
    return this.items.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateItemDto): Promise<ItemResponseDto> {
    return this.items.create(dto);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateItemDto,
  ): Promise<ItemResponseDto> {
    return this.items.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string): Promise<void> {
    return this.items.remove(id);
  }

  @Post(':id/stock-movements')
  addMovement(
    @Param('id') id: string,
    @Body() dto: CreateStockMovementDto,
  ): Promise<MovementResponseDto> {
    return this.items.addMovement(id, dto);
  }
}
