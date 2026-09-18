import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { FinalityService } from '../finality/finality.service';
import { INTENT_STATUSES, IntentStatus } from '../intents/intent-state';
import { IntentsRepository } from '../intents/intents.repository';
import { ConnectionManagerService } from '../xrpl/connection-manager.service';

type CheckState = 'up' | 'down';

export interface ReadinessReport {
  ready: boolean;
  checks: {
    database: CheckState;
    xrpl: CheckState;
    definitions: CheckState;
    ledgerSubscription: CheckState;
    finality: 'healthy' | 'degraded' | 'starting';
    startupRecovery: 'completed' | 'pending';
  };
}

const STATUS_KEYS: Record<IntentStatus, string> = {
  CREATED: 'created',
  PREPARED: 'prepared',
  SIMULATED: 'simulated',
  AWAITING_SIGNATURE: 'awaitingSignature',
  SIGNED: 'signed',
  SUBMITTED: 'submitted',
  VALIDATED: 'validated',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  FAILED: 'failed',
};

@Injectable()
export class HealthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly connection: ConnectionManagerService,
    private readonly finality: FinalityService,
    private readonly intents: IntentsRepository,
  ) {}

  async readiness(): Promise<ReadinessReport> {
    const database: CheckState = (await this.database.isReachable()) ? 'up' : 'down';
    const xrpl = this.connection.status();
    const finality = this.finality.status().status;
    const recovered = this.finality.isRecovered();

    const checks: ReadinessReport['checks'] = {
      database,
      xrpl: xrpl.connected ? 'up' : 'down',
      definitions: xrpl.definitionsCompatible ? 'up' : 'down',
      ledgerSubscription: xrpl.ledgerSubscription ? 'up' : 'down',
      finality:
        finality === 'HEALTHY' ? 'healthy' : finality === 'DEGRADED' ? 'degraded' : 'starting',
      startupRecovery: recovered ? 'completed' : 'pending',
    };
    const ready =
      database === 'up' &&
      xrpl.connected &&
      xrpl.networkId !== null &&
      xrpl.definitionsCompatible &&
      xrpl.ledgerSubscription &&
      finality !== 'DEGRADED' &&
      recovered;
    return { ready, checks };
  }

  async status() {
    const databaseUp = await this.database.isReachable();
    const counts = databaseUp
      ? await this.intents.countByStatus()
      : new Map<IntentStatus, number>();
    const intents: Record<string, number> = {};
    for (const status of INTENT_STATUSES) {
      intents[STATUS_KEYS[status]] = counts.get(status) ?? 0;
    }
    return {
      database: databaseUp ? 'up' : 'down',
      xrpl: this.connection.status(),
      finality: this.finality.status(),
      intents,
    };
  }
}
