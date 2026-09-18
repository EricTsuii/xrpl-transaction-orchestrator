import { Module } from '@nestjs/common';
import { FinalityModule } from '../finality/finality.module';
import { IntentsStoreModule } from '../intents/intents-store.module';
import { XrplModule } from '../xrpl/xrpl.module';
import { FeeService } from './fee.service';
import { PreparationService } from './preparation.service';
import { SimulationService } from './simulation.service';

@Module({
  imports: [IntentsStoreModule, XrplModule, FinalityModule],
  providers: [PreparationService, FeeService, SimulationService],
  exports: [PreparationService],
})
export class PreparationModule {}
