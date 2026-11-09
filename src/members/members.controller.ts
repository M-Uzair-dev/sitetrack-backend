import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/auth-user';
import { InviteDto, MarkReadDto, NotificationsQueryDto, SetAdminDto } from './members.dto';
import { MembersService } from './members.service';

@ApiTags('members')
@ApiBearerAuth()
@Controller('projects/:projectCode')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  /** Members screen: members (with admin flag) and unanswered invitations. */
  @Get('members')
  list(@CurrentUser() user: AuthUser, @Param('projectCode') code: string) {
    return this.members.list(user, code);
  }

  /** Project admins only: make a member a project admin (or revoke admin, keeping at least one). */
  @Patch('members/:userId')
  setAdmin(
    @CurrentUser() user: AuthUser,
    @Param('projectCode') code: string,
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: SetAdminDto,
  ) {
    return this.members.setAdmin(user, code, userId, dto.isAdmin);
  }

  /** Project admins only. Takes effect on the removed person's next request. */
  @Delete('members/:userId')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('projectCode') code: string, @Param('userId', ParseIntPipe) userId: number) {
    await this.members.remove(user, code, userId);
  }

  /** Project admins only: invite a registered user. */
  @Post('invitations')
  invite(@CurrentUser() user: AuthUser, @Param('projectCode') code: string, @Body() dto: InviteDto) {
    return this.members.invite(user, code, dto);
  }

  /** Project admins only: withdraw an unanswered invitation. */
  @Delete('invitations/:invitationId')
  @HttpCode(204)
  async withdraw(@CurrentUser() user: AuthUser, @Param('projectCode') code: string, @Param('invitationId', ParseIntPipe) id: number) {
    await this.members.withdraw(user, code, id);
  }
}

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('me')
export class NotificationsController {
  constructor(private readonly members: MembersService) {}

  /** Notifications screen: the caller's project invitations, newest first. */
  @Get('notifications')
  list(@CurrentUser() user: AuthUser, @Query() q: NotificationsQueryDto) {
    return this.members.notifications(user, q);
  }

  /** Unread badge shown on every page. */
  @Get('notifications/unread-count')
  unread(@CurrentUser() user: AuthUser) {
    return this.members.unreadCount(user);
  }

  @Post('notifications/read')
  @HttpCode(200)
  markRead(@CurrentUser() user: AuthUser, @Body() dto: MarkReadDto) {
    return this.members.markRead(user, dto);
  }

  /** Only the invited person can accept. They join the project on accept. */
  @Post('invitations/:invitationId/accept')
  @HttpCode(200)
  accept(@CurrentUser() user: AuthUser, @Param('invitationId', ParseIntPipe) id: number) {
    return this.members.respond(user, id, true);
  }

  @Post('invitations/:invitationId/reject')
  @HttpCode(200)
  reject(@CurrentUser() user: AuthUser, @Param('invitationId', ParseIntPipe) id: number) {
    return this.members.respond(user, id, false);
  }
}
