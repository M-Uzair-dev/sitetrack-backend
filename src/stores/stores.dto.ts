import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, Min, ValidateNested } from 'class-validator';
import { DATE_RE, PageQueryDto, toList } from '../common/util';

export class LineDto {
  @Type(() => Number) @IsInt() @Min(1)
  materialId: number;

  /** Positive number with up to 3 decimals; send as string or number, e.g. "12.5". */
  @IsNotEmpty()
  quantity: string | number;
}

export class LinesDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200)
  @ValidateNested({ each: true }) @Type(() => LineDto)
  lines: LineDto[];
}

export class CompanyDeliveryDto extends LinesDto {
  /** Destination project, e.g. PRJ-0042. */
  @IsString() @IsNotEmpty()
  projectCode: string;
}

export class ReorderPointDto {
  /** >= 0, up to 3 decimals. */
  @IsNotEmpty()
  reorderPoint: string | number;
}

export const STOCK_SORTS = ['name', 'quantity', 'status'] as const;

export class CompanyStockQueryDto extends PageQueryDto {
  /** Comma-separated: OUT_OF_STOCK,LOW_STOCK,AVAILABLE */
  @IsOptional() @toList() @IsIn(['OUT_OF_STOCK', 'LOW_STOCK', 'AVAILABLE'], { each: true })
  status?: string[];

  @IsOptional() @IsString() @MaxLength(100)
  category?: string;

  @IsOptional() @IsString() @MaxLength(100)
  search?: string;

  @IsOptional() @IsIn(STOCK_SORTS)
  sort?: (typeof STOCK_SORTS)[number];

  @IsOptional() @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';
}

export class ProjectStockQueryDto extends PageQueryDto {
  @IsOptional() @IsString() @MaxLength(100)
  search?: string;

  @IsOptional() @IsString() @MaxLength(100)
  category?: string;

  @IsOptional() @IsIn(['name', 'quantity', 'lastDelivery'])
  sort?: 'name' | 'quantity' | 'lastDelivery';

  @IsOptional() @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';
}

export class DeliveriesQueryDto extends PageQueryDto {
  /** Company deliveries screen only: filter by project code. */
  @IsOptional() @IsString()
  projectCode?: string;

  @IsOptional() @IsIn(['TO_PROJECT', 'TO_COMPANY'])
  direction?: 'TO_PROJECT' | 'TO_COMPANY';

  /** Comma-separated: IN_TRANSIT,DELIVERED,REJECTED,CANCELLED */
  @IsOptional() @toList() @IsIn(['IN_TRANSIT', 'DELIVERED', 'REJECTED', 'CANCELLED'], { each: true })
  status?: string[];

  /** Sent on or after (YYYY-MM-DD). */
  @IsOptional() @Matches(DATE_RE)
  from?: string;

  /** Sent on or before (YYYY-MM-DD). */
  @IsOptional() @Matches(DATE_RE)
  to?: string;
}
