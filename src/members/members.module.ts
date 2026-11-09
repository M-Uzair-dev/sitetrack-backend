import { Module } from '@nestjs/common';
import { MembersController, NotificationsController } from './members.controller';
import { MembersService } from './members.service';

@Module({
  controllers: [MembersController, NotificationsController],
  providers: [MembersService],
})
export class MembersModule {}
