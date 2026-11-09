import { Body, Controller, Delete, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Roles } from '../common/auth-user';
import { paged } from '../common/util';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMaterialDto, ListMaterialsQueryDto, UpdateMaterialDto } from './materials.dto';

const SELECT = { id: true, name: true, category: true, unit: true, createdAt: true } as const;

@Injectable()
export class MaterialsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: ListMaterialsQueryDto) {
    const where: Prisma.MaterialWhereInput = {
      deletedAt: null,
      ...(q.search ? { name: { contains: q.search.trim(), mode: 'insensitive' } } : {}),
      ...(q.category ? { category: q.category } : {}),
    };
    const order = q.order === 'desc' ? 'desc' : 'asc';
    const [data, total] = await Promise.all([
      this.prisma.material.findMany({
        where,
        select: SELECT,
        orderBy: q.sort === 'category' ? [{ category: order }, { name: order }] : [{ name: order }, { id: order }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.material.count({ where }),
    ]);
    return paged(data, total, q);
  }

  async categories() {
    const rows = await this.prisma.material.groupBy({ by: ['category'], where: { deletedAt: null }, orderBy: { category: 'asc' } });
    return rows.map((r) => r.category);
  }

  async get(id: number) {
    const m = await this.prisma.material.findFirst({ where: { id, deletedAt: null }, select: SELECT });
    if (!m) throw new NotFoundException('Material not found');
    return m;
  }

  create(dto: CreateMaterialDto) {
    return this.prisma.material.create({ data: { name: dto.name.trim(), category: dto.category.trim(), unit: dto.unit.trim() }, select: SELECT });
  }

  async update(id: number, dto: UpdateMaterialDto) {
    await this.get(id);
    return this.prisma.material.update({
      where: { id },
      data: { name: dto.name?.trim(), category: dto.category?.trim(), unit: dto.unit?.trim() },
      select: SELECT,
    });
  }

  /** Soft delete: stock and delivery history keep referring to it. */
  async remove(id: number) {
    await this.get(id);
    await this.prisma.material.update({ where: { id }, data: { deletedAt: new Date() } });
  }
}

@ApiTags('materials')
@ApiBearerAuth()
@Controller('materials')
export class MaterialsController {
  constructor(private readonly materials: MaterialsService) {}

  /** The shared catalogue, visible to everyone logged in. */
  @Get()
  list(@Query() q: ListMaterialsQueryDto) {
    return this.materials.list(q);
  }

  /** Distinct categories (for filter dropdowns). */
  @Get('categories')
  categories() {
    return this.materials.categories();
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.materials.get(id);
  }

  /** Company store managers and SuperAdmins only. */
  @Roles('COMPANY_STORE_MANAGER', 'SUPER_ADMIN')
  @Post()
  create(@Body() dto: CreateMaterialDto) {
    return this.materials.create(dto);
  }

  @Roles('COMPANY_STORE_MANAGER', 'SUPER_ADMIN')
  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateMaterialDto) {
    return this.materials.update(id, dto);
  }

  @Roles('COMPANY_STORE_MANAGER', 'SUPER_ADMIN')
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.materials.remove(id);
  }
}

@Module({ controllers: [MaterialsController], providers: [MaterialsService] })
export class MaterialsModule {}
