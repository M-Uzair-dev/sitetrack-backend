import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ApiTags } from '@nestjs/swagger';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Public } from './common/auth-user';
import { MaterialsModule } from './materials/materials.module';
import { MembersModule } from './members/members.module';
import { PrismaModule } from './prisma/prisma.service';
import { ProjectsModule } from './projects/projects.module';
import { StoresModule } from './stores/stores.module';
import { TasksModule } from './tasks/tasks.module';

@ApiTags('health')
@Controller('health')
class HealthController {
  @Public()
  @Get()
  health() {
    return { status: 'ok' };
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    ProjectsModule,
    MembersModule,
    TasksModule,
    MaterialsModule,
    StoresModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AppModule {}
