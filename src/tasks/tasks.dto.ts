import { ArrayMaxSize, IsArray, IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { DATE_RE, PageQueryDto, toBool, toList } from '../common/util';

export class CreateTaskDto {
  @IsString() @IsNotEmpty() @MaxLength(300)
  name: string;

  /** YYYY-MM-DD */
  @Matches(DATE_RE, { message: 'plannedStart must be YYYY-MM-DD' })
  plannedStart: string;

  /** YYYY-MM-DD */
  @Matches(DATE_RE, { message: 'plannedEnd must be YYYY-MM-DD' })
  plannedEnd: string;

  /** Codes of tasks (same project) this task waits on. */
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsString({ each: true })
  dependsOn?: string[];
}

export class UpdateTaskDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(300)
  name?: string;

  @IsOptional() @Matches(DATE_RE, { message: 'plannedStart must be YYYY-MM-DD' })
  plannedStart?: string;

  @IsOptional() @Matches(DATE_RE, { message: 'plannedEnd must be YYYY-MM-DD' })
  plannedEnd?: string;
}

export class AddDependencyDto {
  /** Code of the task that must be done first, e.g. PRJ-0042-T-0003. */
  @IsString() @IsNotEmpty()
  dependsOn: string;
}

export const TASK_SORTS = ['code', 'name', 'startDate', 'endDate', 'dependentsCount'] as const;

export class ListTasksQueryDto extends PageQueryDto {
  /** Comma-separated: NOT_STARTED,IN_PROGRESS,DONE */
  @IsOptional() @toList() @IsIn(['NOT_STARTED', 'IN_PROGRESS', 'DONE'], { each: true })
  status?: string[];

  @IsOptional() @toBool()
  late?: boolean;

  @IsOptional() @toBool()
  blocked?: boolean;

  /** Planned date range start (YYYY-MM-DD). Tasks whose planned period overlaps [from, to] match. */
  @IsOptional() @Matches(DATE_RE)
  from?: string;

  @IsOptional() @Matches(DATE_RE)
  to?: string;

  /** Matches task name or ID (contains, case-insensitive). */
  @IsOptional() @IsString() @MaxLength(100)
  search?: string;

  @IsOptional() @IsIn(TASK_SORTS)
  sort?: (typeof TASK_SORTS)[number];

  @IsOptional() @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';
}
