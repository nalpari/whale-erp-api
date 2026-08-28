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
import { CreateItemDto } from './dto/create-item.dto';
import { CreateStockMovementDto } from './dto/create-stock-movement.dto';
import { ItemResponseDto, MovementResponseDto } from './dto/item.response.dto';
import { ListItemsQueryDto } from './dto/list-items-query.dto';
import { UpdateItemDto } from './dto/update-item.dto';
import { ItemsService } from './items.service';

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
