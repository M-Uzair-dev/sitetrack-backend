import { BadRequestException } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parses a strict YYYY-MM-DD string into a UTC-midnight Date. */
export function parseDate(value: string, field = 'date'): Date {
  if (!DATE_RE.test(value)) throw new BadRequestException(`${field} must be YYYY-MM-DD`);
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException(`${field} is not a valid date`);
  }
  return d;
}

/** Formats a Date (stored as a Postgres DATE) back to YYYY-MM-DD. */
export const toDateStr = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);

/** Today's date in UTC as YYYY-MM-DD; used for the Late flag everywhere. */
export const todayStr = () => new Date().toISOString().slice(0, 10);

export const pad4 = (n: number) => String(n).padStart(4, '0');

/** Escapes LIKE wildcards in user input. */
export const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);

export const toBool = () =>
  Transform(({ value }) => (value === undefined || value === '' ? undefined : value === true || value === 'true' || value === '1'));

export const toList = () =>
  Transform(({ value }) =>
    value === undefined || value === '' ? undefined : (Array.isArray(value) ? value : String(value).split(',')).map((v: string) => v.trim()).filter(Boolean),
  );

export class PageQueryDto {
  /** 1-based page number. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page: number = 1;

  /** Items per page (max 100). */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  pageSize: number = 25;
}

export interface Page<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
}

export const paged = <T>(data: T[], total: number, q: PageQueryDto): Page<T> => ({ data, page: q.page, pageSize: q.pageSize, total });

/** Validates a positive quantity with at most 3 decimals and returns it normalised as a string. */
export function parseQty(v: unknown, field = 'quantity', allowZero = false): string {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  if (!/^\d{1,11}(\.\d{1,3})?$/.test(s)) throw new BadRequestException(`${field} must be a number with at most 3 decimals`);
  if (!allowZero && Number(s) <= 0) throw new BadRequestException(`${field} must be greater than 0`);
  return s;
}
