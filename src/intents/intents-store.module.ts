import { Module } from '@nestjs/common';
import { IntentsRepository } from './intents.repository';
import { TransitionsRepository } from './transitions.repository';

/**
 * Persistence for intents and their transitions. Separate from IntentsModule
 * so that the preparation, signing, submission and finality modules can use
 * it while IntentsModule's controller uses them, without a module cycle.
 */
@Module({
  providers: [IntentsRepository, TransitionsRepository],
  exports: [IntentsRepository, TransitionsRepository],
})
export class IntentsStoreModule {}
