import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/auth-user';
import { CreateProjectDto, ListProjectsQueryDto, UpdateProjectDto } from './projects.dto';
import { ProjectsService } from './projects.service';

@ApiTags('projects')
@ApiBearerAuth()
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  /** Create a project. The creator becomes its first project admin. */
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateProjectDto) {
    return this.projects.create(user, dto);
  }

  /** Projects screen: every project the caller can access, with task stats. */
  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: ListProjectsQueryDto) {
    return this.projects.list(user, q);
  }

  @Get(':projectCode')
  get(@CurrentUser() user: AuthUser, @Param('projectCode') code: string) {
    return this.projects.getOne(user, code);
  }

  /** Project admins only. */
  @Patch(':projectCode')
  update(@CurrentUser() user: AuthUser, @Param('projectCode') code: string, @Body() dto: UpdateProjectDto) {
    return this.projects.update(user, code, dto);
  }

  /** Project admins only. Soft delete; the ID is never reused. */
  @Delete(':projectCode')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('projectCode') code: string) {
    await this.projects.remove(user, code);
  }
}
