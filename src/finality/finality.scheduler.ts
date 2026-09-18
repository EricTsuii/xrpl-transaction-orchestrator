import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { FINALITY_RECONCILE_INTERVAL_MS } from '../common/constants';
import { ConnectionManagerService } from '../xrpl/connection-manager.service';
import { FinalityService } from './finality.service';

/**
 * Triggers finality cycles at startup, on every validated ledger event and
 * every 10 seconds. The ledger stream only lowers latency; the interval is
 * the correctness path, so a missed event never loses an outcome.
 */
@Injectable()
export class FinalityScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly finality: FinalityService,
    private readonly connection: ConnectionManagerService,
  ) {}

  onApplicationBootstrap(): void {
    this.connection.onValidatedLedger(() => this.trigger());
    this.timer = setInterval(() => this.trigger(), FINALITY_RECONCILE_INTERVAL_MS);
    this.timer.unref();
    this.trigger();
  }

  /**
   * Nest runs onModuleDestroy before any onApplicationShutdown, so the last
   * cycle finishes while the database pool and XRPL connection still exist.
   */
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.finality.idle();
  }

  private trigger(): void {
    if (!this.stopped) {
      void this.finality.runCycle();
    }
  }
}
