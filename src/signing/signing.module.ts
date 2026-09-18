import { Module } from '@nestjs/common';
import { FinalityModule } from '../finality/finality.module';
import { IntentsStoreModule } from '../intents/intents-store.module';
import { XrplModule } from '../xrpl/xrpl.module';
import { SignedBlobService } from './signed-blob.service';
import { SignerAuthorizationService } from './signer-authorization.service';
import { SigningService } from './signing.service';

@Module({
  imports: [IntentsStoreModule, XrplModule, FinalityModule],
  providers: [SigningService, SignedBlobService, SignerAuthorizationService],
  exports: [SigningService],
})
export class SigningModule {}
