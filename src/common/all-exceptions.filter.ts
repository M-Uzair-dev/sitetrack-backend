import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';

/** Every error leaves the API in one shape: { statusCode, error, message, details? }. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const send = (statusCode: number, message: string, details?: unknown) =>
      res.status(statusCode).json({
        statusCode,
        error: (HttpStatus[statusCode] ?? 'ERROR').toString().replace(/_/g, ' '),
        message,
        ...(details !== undefined ? { details } : {}),
      });

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse() as string | { message?: string | string[] };
      if (typeof body === 'string') return send(status, body);
      if (Array.isArray(body.message)) return send(status, 'Validation failed', body.message);
      return send(status, body.message ?? exception.message);
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') return send(409, 'A record with these values already exists');
      if (exception.code === 'P2025') return send(404, 'Not found');
      if (exception.code === 'P2003') return send(409, 'Referenced record does not exist or is still in use');
      const msg = String(exception.message);
      if (msg.includes('23514') || msg.includes('check constraint')) return send(409, 'Operation would violate a data rule (e.g. negative stock)');
    }

    // body-parser errors (malformed JSON etc.)
    const e = exception as { status?: number; type?: string; message?: string };
    if (e && e.status === 400 && e.type) return send(400, 'Malformed request body');

    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    return send(500, 'Internal server error');
  }
}
