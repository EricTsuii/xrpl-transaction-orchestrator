import { Module } from '@nestjs/common';
import { CapabilityService } from './capability.service';
import { ConnectionManagerService } from './connection-manager.service';
import { LEDGER_CLIENT_FACTORY, LedgerClientFactory } from './ledger-client.interface';
import { LedgerService } from './ledger.service';
import { XrplLedgerClient } from './xrpl-ledger.client';

const realClientFactory: LedgerClientFactory = (url) => new XrplLedgerClient(url);

@Module({
  providers: [
    { provide: LEDGER_CLIENT_FACTORY, useValue: realClientFactory },
    CapabilityService,
    ConnectionManagerService,
    LedgerService,
  ],
  exports: [ConnectionManagerService, LedgerService],
})
export class XrplModule {}
