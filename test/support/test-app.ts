import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp, createAdapter } from '../../src/app.setup';
import { DatabaseService } from '../../src/database/database.service';
import { FinalityService } from '../../src/finality/finality.service';
import { LEDGER_CLIENT_FACTORY } from '../../src/xrpl/ledger-client.interface';
import { FakeLedgerNetwork } from '../fakes/fake-ledger-client';
import { useTestEnvironment } from './environment';

export interface TestApp {
  app: NestFastifyApplication;
  network: FakeLedgerNetwork;
  http: () => ReturnType<typeof request>;
  finality: FinalityService;
  database: DatabaseService;
  close: () => Promise<void>;
}

/**
 * Boots the real application, configured exactly as main.ts does, with the
 * FakeLedgerClient in place of xrpl.Client. The database is real.
 */
export async function startTestApp(
  network = new FakeLedgerNetwork(),
  options: { truncate?: boolean } = {},
): Promise<TestApp> {
  useTestEnvironment();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LEDGER_CLIENT_FACTORY)
    .useValue(network.factory)
    .compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter(), {
    logger: false,
  });
  configureApp(app);

  const database = app.get(DatabaseService);
  if (options.truncate ?? true) {
    await truncate(database);
  }

  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const finality = app.get(FinalityService);
  // Wait for the startup recovery pass the scheduler started.
  await finality.runCycle();

  return {
    app,
    network,
    finality,
    database,
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
  };
}

export async function truncate(database: DatabaseService): Promise<void> {
  await database.db.execute(
    sql`TRUNCATE transaction_intents, intent_transitions RESTART IDENTITY CASCADE`,
  );
}
