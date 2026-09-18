import { Module } from '@nestjs/common';
import { FinalityModule } from '../finality/finality.module';
import { IntentsStoreModule } from '../intents/intents-store.module';
import { XrplModule } from '../xrpl/xrpl.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [XrplModule, FinalityModule, IntentsStoreModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
