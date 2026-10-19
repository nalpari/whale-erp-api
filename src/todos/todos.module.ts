import { Module } from '@nestjs/common';
import { AdminScopeModule } from '../admin-scope/admin-scope.module';
import { BatchModule } from '../batch/batch.module';
import { MyTodosController } from './my-todos.controller';
import { StaffMemberTodosController } from './staff-member-todos.controller';
import { TodoDueSoonScheduler } from './todo-due-soon.scheduler';
import { TodoDueSoonService } from './todo-due-soon.service';
import { TodosController } from './todos.controller';
import { TodosService } from './todos.service';

@Module({
  imports: [BatchModule, AdminScopeModule],
  controllers: [TodosController, StaffMemberTodosController, MyTodosController],
  providers: [TodosService, TodoDueSoonService, TodoDueSoonScheduler],
})
export class TodosModule {}
