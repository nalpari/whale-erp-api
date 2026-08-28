import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CreateItemDto } from './dto/create-item.dto';
import { CreateStockMovementDto } from './dto/create-stock-movement.dto';
import { ItemResponseDto, MovementResponseDto } from './dto/item.response.dto';
import { ItemsService } from './items.service';

@Controller('items')
export class ItemsController {
  constructor(private readonly items: ItemsService) {}

  @Get()
  findAll(): Promise<ItemResponseDto[]> {
    return this.items.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string): Promise<ItemResponseDto> {
    return this.items.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateItemDto): Promise<ItemResponseDto> {
    return this.items.create(dto);
  }

  @Post(':id/stock-movements')
  addMovement(
    @Param('id') id: string,
    @Body() dto: CreateStockMovementDto,
  ): Promise<MovementResponseDto> {
    return this.items.addMovement(id, dto);
  }
}
