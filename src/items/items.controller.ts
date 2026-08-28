import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CreateItemDto } from './dto/create-item.dto';
import { CreateStockMovementDto } from './dto/create-stock-movement.dto';
import { ItemResponse, ItemsService, MovementResponse } from './items.service';

@Controller('items')
export class ItemsController {
  constructor(private readonly items: ItemsService) {}

  @Get()
  findAll(): Promise<ItemResponse[]> {
    return this.items.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string): Promise<ItemResponse> {
    return this.items.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateItemDto): Promise<ItemResponse> {
    return this.items.create(dto);
  }

  @Post(':id/stock-movements')
  addMovement(
    @Param('id') id: string,
    @Body() dto: CreateStockMovementDto,
  ): Promise<MovementResponse> {
    return this.items.addMovement(id, dto);
  }
}
