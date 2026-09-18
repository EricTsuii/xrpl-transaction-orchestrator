import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getRequestId } from '../request-id/request-id';
import { ApiError } from './api-error';
import { ERROR_HTTP_STATUS, ErrorCode } from './error-codes';

interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    details?: Record<string, string | number | boolean | null>;
  };
}

/**
 * Converts every failure into the public error envelope. Stack traces and
 * internal messages never reach the client.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const requestId = getRequestId(request);

    const { code, message, details } = this.describe(exception, requestId);
    const body: ErrorBody = { error: { code, message, requestId } };
    if (details !== undefined) {
      body.error.details = details;
    }
    void reply.status(ERROR_HTTP_STATUS[code]).send(body);
  }

  private describe(
    exception: unknown,
    requestId: string,
  ): { code: ErrorCode; message: string; details?: ErrorBody['error']['details'] } {
    if (exception instanceof ApiError) {
      return { code: exception.code, message: exception.message, details: exception.details };
    }

    if (exception instanceof HttpException) {
      if (exception.getStatus() < 500) {
        return { code: 'VALIDATION_ERROR', message: validationMessage(exception) };
      }
    } else if (isClientTransportError(exception)) {
      // Fastify content-parser failures: malformed JSON, oversized body,
      // unsupported media type.
      return { code: 'VALIDATION_ERROR', message: 'The request body could not be accepted.' };
    }

    const error = exception instanceof Error ? exception : new Error('non-error thrown');
    this.logger.error(`request ${requestId} failed: ${error.name}: ${error.message}`, error.stack);
    return { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' };
  }
}

function validationMessage(exception: HttpException): string {
  const response = exception.getResponse();
  if (typeof response === 'object' && response !== null && 'message' in response) {
    const message = response.message;
    if (Array.isArray(message)) {
      return message.filter((item): item is string => typeof item === 'string').join('; ');
    }
    if (typeof message === 'string') {
      return message;
    }
  }
  return exception.message;
}

function isClientTransportError(exception: unknown): boolean {
  if (typeof exception !== 'object' || exception === null) {
    return false;
  }
  const statusCode = (exception as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500;
}
