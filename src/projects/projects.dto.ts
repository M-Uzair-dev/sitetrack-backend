import { IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { DATE_RE, PageQueryDto, toBool } from '../common/util';

export class CreateProjectDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  name: string;

  /** YYYY-MM-DD */
  @Matches(DATE_RE, { message: 'plannedStart must be YYYY-MM-DD' })
  plannedStart: string;

  /** YYYY-MM-DD, on or after plannedStart */
  @Matches(DATE_RE, { message: 'plannedEnd must be YYYY-MM-DD' })
  plannedEnd: string;
}

export class UpdateProjectDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200)
  name?: string;

  @IsOptional() @Matches(DATE_RE, { message: 'plannedStart must be YYYY-MM-DD' })
  plannedStart?: string;

  @IsOptional() @Matches(DATE_RE, { message: 'plannedEnd must be YYYY-MM-DD' })
  plannedEnd?: string;
}

export const PROJECT_SORTS = ['name', 'startDate', 'percentDone', 'lateTasks'] as const;

export class ListProjectsQueryDto extends PageQueryDto {
  /** Matches project name (contains) or ID (e.g. "PRJ-004"). */
  @IsOptional() @IsString() @MaxLength(100)
  search?: string;

  /** Only projects that have at least one late task. */
  @IsOptional() @toBool()
  hasLateTasks?: boolean;

  @IsOptional() @IsIn(PROJECT_SORTS)
  sort?: (typeof PROJECT_SORTS)[number];

  @IsOptional() @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';
}
