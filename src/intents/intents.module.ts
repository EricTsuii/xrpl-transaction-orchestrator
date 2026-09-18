import { Module } from '@nestjs/common';
import { PreparationModule } from '../preparation/preparation.module';
import { SigningModule } from '../signing/signing.module';
import { SubmissionModule } from '../submission/submission.module';
import { IntentsStoreModule } from './intents-store.module';
import { IntentsController } from './intents.controller';
import { IntentsService } from './intents.service';

@Module({
  imports: [IntentsStoreModule, PreparationModule, SigningModule, SubmissionModule],
  controllers: [IntentsController],
  providers: [IntentsService],
})
export class IntentsModule {}
