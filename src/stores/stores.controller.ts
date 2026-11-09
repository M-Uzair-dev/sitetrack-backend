import { Body, Controller, Get, HttpCode, Module, NotFoundException, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser, Roles } from '../common/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { CompanyDeliveryDto, CompanyStockQueryDto, DeliveriesQueryDto, LinesDto, ProjectStockQueryDto, ReorderPointDto } from './stores.dto';
import { StoresService } from './stores.service';

/** Company store: company store managers and SuperAdmins only. */
@ApiTags('company store')
@ApiBearerAuth()
@Roles('COMPANY_STORE_MANAGER', 'SUPER_ADMIN')
@Controller('company-store')
export class CompanyStoreController {
  constructor(private readonly stores: StoresService, private readonly prisma: PrismaService) {}

  /** Company store: Stock screen. */
  @Get('stock')
  stock(@Query() q: CompanyStockQueryDto) {
    return this.stores.companyStock(q);
  }

  /** Add stock arriving from a supplier. */
  @Post('stock')
  addStock(@Body() dto: LinesDto) {
    return this.stores.addStock(dto.lines);
  }

  @Put('stock/:materialId/reorder-point')
  reorderPoint(@Param('materialId', ParseIntPipe) materialId: number, @Body() dto: ReorderPointDto) {
    return this.stores.setReorderPoint(materialId, dto.reorderPoint);
  }

  /** Company store: Deliveries screen (all projects, newest first). */
  @Get('deliveries')
  deliveries(@Query() q: DeliveriesQueryDto) {
    return this.stores.listDeliveries(q, {});
  }

  @Get('deliveries/:id')
  delivery(@Param('id', ParseIntPipe) id: number) {
    return this.stores.getDelivery(id, {});
  }

  /** Send material from the company store to a project store. */
  @Post('deliveries')
  async send(@CurrentUser() user: AuthUser, @Body() dto: CompanyDeliveryDto) {
    const project = await this.prisma.project.findFirst({ where: { code: dto.projectCode.toUpperCase(), deletedAt: null }, select: { id: true } });
    if (!project) throw new NotFoundException('Project not found');
    return this.stores.initiate('TO_PROJECT', project.id, dto.lines, user);
  }

  /** Record a delivery coming back from a project: stock joins the company store. */
  @Post('deliveries/:id/record')
  @HttpCode(200)
  record(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.stores.transition(id, 'TO_COMPANY', 'DELIVERED', user, {});
  }

  /** Reject a delivery coming back from a project: stock returns to the project store. */
  @Post('deliveries/:id/reject')
  @HttpCode(200)
  reject(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.stores.transition(id, 'TO_COMPANY', 'REJECTED', user, {});
  }

  /** Cancel a delivery the company store sent that is still in transit. */
  @Post('deliveries/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.stores.transition(id, 'TO_PROJECT', 'CANCELLED', user, {});
  }
}

/** Project store and its deliveries: project members (and SuperAdmins). */
@ApiTags('project store')
@ApiBearerAuth()
@Controller('projects/:projectCode')
export class ProjectStoreController {
  constructor(private readonly stores: StoresService, private readonly access: ProjectAccessService) {}

  /** Project: Store screen. */
  @Get('store')
  async stock(@CurrentUser() user: AuthUser, @Param('projectCode') code: string, @Query() q: ProjectStockQueryDto) {
    const { project } = await this.access.resolve(user, code);
    return this.stores.projectStock(project.id, q);
  }

  /** Project: Deliveries screen (incoming and outgoing, newest first). */
  @Get('deliveries')
  async deliveries(@CurrentUser() user: AuthUser, @Param('projectCode') code: string, @Query() q: DeliveriesQueryDto) {
    const { project } = await this.access.resolve(user, code);
    return this.stores.listDeliveries(q, { projectId: project.id });
  }

  @Get('deliveries/:id')
  async delivery(@CurrentUser() user: AuthUser, @Param('projectCode') code: string, @Param('id', ParseIntPipe) id: number) {
    const { project } = await this.access.resolve(user, code);
    return this.stores.getDelivery(id, { projectId: project.id });
  }

  /** Send material back to the company store. */
  @Post('deliveries')
  async send(@CurrentUser() user: AuthUser, @Param('projectCode') code: string, @Body() dto: LinesDto) {
    const { project } = await this.access.resolve(user, code);
    return this.stores.initiate('TO_COMPANY', project.id, dto.lines, user);
  }

  /** Record an incoming delivery: stock joins the project store. */
  @Post('deliveries/:id/record')
  @HttpCode(200)
  async record(@CurrentUser() user: AuthUser, @Param('projectCode') code: string, @Param('id', ParseIntPipe) id: number) {
    const { project } = await this.access.resolve(user, code);
    return this.stores.transition(id, 'TO_PROJECT', 'DELIVERED', user, { projectId: project.id });
  }

  /** Reject an incoming delivery: stock returns to the company store. */
  @Post('deliveries/:id/reject')
  @HttpCode(200)
  async reject(@CurrentUser() user: AuthUser, @Param('projectCode') code: string, @Param('id', ParseIntPipe) id: number) {
    const { project } = await this.access.resolve(user, code);
    return this.stores.transition(id, 'TO_PROJECT', 'REJECTED', user, { projectId: project.id });
  }

  /** Cancel a return this project sent that is still in transit. */
  @Post('deliveries/:id/cancel')
  @HttpCode(200)
  async cancel(@CurrentUser() user: AuthUser, @Param('projectCode') code: string, @Param('id', ParseIntPipe) id: number) {
    const { project } = await this.access.resolve(user, code);
    return this.stores.transition(id, 'TO_COMPANY', 'CANCELLED', user, { projectId: project.id });
  }
}

@Module({
  controllers: [CompanyStoreController, ProjectStoreController],
  providers: [StoresService],
})
export class StoresModule {}
