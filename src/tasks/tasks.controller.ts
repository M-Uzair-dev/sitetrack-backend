import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/auth-user';
import { AddDependencyDto, CreateTaskDto, ListTasksQueryDto, UpdateTaskDto } from './tasks.dto';
import { TasksService } from './tasks.service';

@ApiTags('tasks')
@ApiBearerAuth()
@Controller('projects/:projectCode/tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  /** Project: Tasks screen. Late/Blocked are derived from today's date and the dependency graph. */
  @Get()
  list(@CurrentUser() user: AuthUser, @Param('projectCode') code: string, @Query() q: ListTasksQueryDto) {
    return this.tasks.list(user, code, q);
  }

  /** Create a task; optionally with dependencies (codes of tasks in the same project). */
  @Post()
  create(@CurrentUser() user: AuthUser, @Param('projectCode') code: string, @Body() dto: CreateTaskDto) {
    return this.tasks.create(user, code, dto);
  }

  /** Task details: allowed actions plus every task it waits on / that waits on it, with distance. */
  @Get(':taskCode')
  detail(@CurrentUser() user: AuthUser, @Param('projectCode') code: string, @Param('taskCode') taskCode: string) {
    return this.tasks.detail(user, code, taskCode);
  }

  /** Edit name and planned dates. Status changes only through the action endpoints. */
  @Patch(':taskCode')
  update(@CurrentUser() user: AuthUser, @Param('projectCode') code: string, @Param('taskCode') taskCode: string, @Body() dto: UpdateTaskDto) {
    return this.tasks.update(user, code, taskCode, dto);
  }

  /** Delete a task and its dependency links. Its ID is never reused. */
  @Delete(':taskCode')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('projectCode') code: string, @Param('taskCode') taskCode: string) {
    await this.tasks.remove(user, code, taskCode);
  }

  /** Not started -> In progress. Allowed only when every task it waits on is done. */
  @Post(':taskCode/start')
  @HttpCode(200)
  start(@CurrentUser() user: AuthUser, @Param('projectCode') code: string, @Param('taskCode') taskCode: string) {
    return this.tasks.action(user, code, taskCode, 'start');
  }

  /** In progress -> Done. */
  @Post(':taskCode/complete')
  @HttpCode(200)
  complete(@CurrentUser() user: AuthUser, @Param('projectCode') code: string, @Param('taskCode') taskCode: string) {
    return this.tasks.action(user, code, taskCode, 'complete');
  }

  /** Done -> In progress. Allowed only while no task that waits on it has started. */
  @Post(':taskCode/reopen')
  @HttpCode(200)
  reopen(@CurrentUser() user: AuthUser, @Param('projectCode') code: string, @Param('taskCode') taskCode: string) {
    return this.tasks.action(user, code, taskCode, 'reopen');
  }

  /** Make this task wait on another task of the same project. Cycles are rejected (409). */
  @Post(':taskCode/dependencies')
  addDependency(@CurrentUser() user: AuthUser, @Param('projectCode') code: string, @Param('taskCode') taskCode: string, @Body() dto: AddDependencyDto) {
    return this.tasks.addDependency(user, code, taskCode, dto);
  }

  @Delete(':taskCode/dependencies/:dependsOnCode')
  @HttpCode(204)
  async removeDependency(
    @CurrentUser() user: AuthUser,
    @Param('projectCode') code: string,
    @Param('taskCode') taskCode: string,
    @Param('dependsOnCode') dependsOnCode: string,
  ) {
    await this.tasks.removeDependency(user, code, taskCode, dependsOnCode);
  }
}
