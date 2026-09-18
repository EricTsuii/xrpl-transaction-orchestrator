import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { AppConfigService } from '../config/config.service';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;

/** A Drizzle handle that is either the pool or an open transaction. */
export type DbExecutor = Pick<Database, 'select' | 'insert' | 'update' | 'execute'>;

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  readonly pool: Pool;
  readonly db: Database;

  constructor(config: AppConfigService) {
    this.pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
    // A broken idle connection must not crash the process; the next query
    // reports the failure through the normal path.
    this.pool.on('error', () => undefined);
    this.db = drizzle(this.pool, { schema });
  }

  /** Runs `work` in one PostgreSQL transaction: all of it commits or none of it does. */
  transaction<T>(work: (tx: DbExecutor) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => work(tx));
  }

  async isReachable(): Promise<boolean> {
    try {
      await this.db.execute(sql`SELECT 1`);
      return true;
    } catch {
      return false;
    }
  }

  /** Runs last on shutdown, after the finality scheduler has stopped. */
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
