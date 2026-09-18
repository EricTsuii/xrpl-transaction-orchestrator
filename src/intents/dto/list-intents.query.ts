import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { INTENT_LIST_MAX_LIMIT } from '../../common/constants';
import { INTENT_STATUSES, INTENT_TYPES, IntentStatus, IntentType } from '../intent-state';
import { IsClassicAddress } from './validators';

export class ListIntentsQuery {
  @IsOptional()
  @IsIn(INTENT_TYPES)
  type?: IntentType;

  @IsOptional()
  @IsIn(INTENT_STATUSES)
  status?: IntentStatus;

  @IsOptional()
  @IsClassicAddress()
  account?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(INTENT_LIST_MAX_LIMIT)
  limit?: number;

  @IsOptional()
  @IsString()
  cursor?: string;
}
