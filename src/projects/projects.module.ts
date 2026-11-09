import { Global, Module } from '@nestjs/common';
import { ProjectAccessService } from './project-access.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Global()
@Module({
  controllers: [ProjectsController],
  providers: [ProjectsService, ProjectAccessService],
  exports: [ProjectAccessService],
})
export class ProjectsModule {}
