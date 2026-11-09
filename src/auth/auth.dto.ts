import { AppRole } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEmail, IsEnum, IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

const trimLower = () => Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value));

export class RegisterDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name: string;

  @IsEmail() @MaxLength(254) @trimLower()
  email: string;

  /** At least 8 characters. */
  @IsString() @MinLength(8) @MaxLength(200)
  password: string;

  /** App role, chosen at registration. */
  @IsEnum(AppRole)
  role: AppRole;
}

export class LoginDto {
  @IsEmail() @trimLower()
  email: string;

  @IsString() @IsNotEmpty() @MaxLength(200)
  password: string;
}

export class RefreshDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  refreshToken: string;
}
