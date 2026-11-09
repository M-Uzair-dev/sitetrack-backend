import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { PageQueryDto } from '../common/util';

export class CreateMaterialDto {
  /** e.g. "Cement, OPC 50 kg bag" */
  @IsString() @IsNotEmpty() @MaxLength(200)
  name: string;

  /** e.g. "Cement" */
  @IsString() @IsNotEmpty() @MaxLength(100)
  category: string;

  /** e.g. "bag" */
  @IsString() @IsNotEmpty() @MaxLength(30)
  unit: string;
}

export class UpdateMaterialDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200)
  name?: string;

  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100)
  category?: string;

  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(30)
  unit?: string;
}

export class ListMaterialsQueryDto extends PageQueryDto {
  @IsOptional() @IsString() @MaxLength(100)
  search?: string;

  @IsOptional() @IsString() @MaxLength(100)
  category?: string;

  @IsOptional() @IsIn(['name', 'category'])
  sort?: 'name' | 'category';

  @IsOptional() @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';
}
