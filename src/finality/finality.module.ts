import { Module } from '@nestjs/common';
import { IntentsStoreModule } from '../intents/intents-store.module';
import { XrplModule } from '../xrpl/xrpl.module';
import { FinalityScheduler } from './finality.scheduler';
import { FinalityService } from './finality.service';

@Module({
  imports: [IntentsStoreModule, XrplModule],
  providers: [FinalityService, FinalityScheduler],
  exports: [FinalityService],
})
export class FinalityModule {}
