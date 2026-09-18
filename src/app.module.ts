import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { FinalityModule } from './finality/finality.module';
import { HealthModule } from './health/health.module';
import { IntentsModule } from './intents/intents.module';
import { PreparationModule } from './preparation/preparation.module';
import { SigningModule } from './signing/signing.module';
import { SubmissionModule } from './submission/submission.module';
import { XrplModule } from './xrpl/xrpl.module';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    HealthModule,
    XrplModule,
    IntentsModule,
    PreparationModule,
    SigningModule,
    SubmissionModule,
    FinalityModule,
  ],
})
export class AppModule {}
