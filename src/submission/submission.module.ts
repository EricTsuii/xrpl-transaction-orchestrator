import { Module } from '@nestjs/common';
import { FinalityModule } from '../finality/finality.module';
import { IntentsStoreModule } from '../intents/intents-store.module';
import { XrplModule } from '../xrpl/xrpl.module';
import { SubmissionService } from './submission.service';

@Module({
  imports: [IntentsStoreModule, XrplModule, FinalityModule],
  providers: [SubmissionService],
  exports: [SubmissionService],
})
export class SubmissionModule {}
