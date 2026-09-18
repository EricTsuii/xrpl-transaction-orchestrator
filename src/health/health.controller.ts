import { Controller, Get, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { HealthService } from './health.service';

@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Process liveness only. */
  @Get('healthz')
  healthz() {
    return { status: 'ok' };
  }

  @Get('readyz')
  async readyz(@Res({ passthrough: true }) reply: FastifyReply) {
    const report = await this.health.readiness();
    if (!report.ready) {
      void reply.status(503);
      return { status: 'not_ready', checks: report.checks };
    }
    return { status: 'ready', checks: report.checks };
  }

  @Get('v1/status')
  async status() {
    return { data: await this.health.status() };
  }
}
