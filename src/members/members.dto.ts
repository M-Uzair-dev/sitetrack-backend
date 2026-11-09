import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsInt, IsOptional, Min, ValidateIf } from 'class-validator';
import { PageQueryDto } from '../common/util';

export class InviteDto {
  /** Invite by user id ... */
  @ValidateIf((o) => o.email === undefined)
  @Type(() => Number) @IsInt() @Min(1)
  userId?: number;

  /** ... or by email. */
  @ValidateIf((o) => o.userId === undefined)
  @IsEmail()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  email?: string;
}

export class SetAdminDto {
  @IsBoolean()
  isAdmin: boolean;
}

export class MarkReadDto {
  /** Invitation ids to mark as read. Omit to mark all as read. */
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsInt({ each: true })
  ids?: number[];
}

export class NotificationsQueryDto extends PageQueryDto {}
