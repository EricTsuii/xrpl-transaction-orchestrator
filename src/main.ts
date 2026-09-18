import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { configureApp, createAdapter } from './app.setup';
import { AppConfigService } from './config/config.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, createAdapter(), {
    bufferLogs: true,
  });
  configureApp(app);
  app.enableShutdownHooks();

  // All interfaces inside the container; compose publishes the port on
  // 127.0.0.1 only. See SECURITY.md, Network exposure.
  await app.listen(app.get(AppConfigService).port, '0.0.0.0');
}

void bootstrap();
