import { Type } from 'class-transformer';
import {
  Equals,
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { UINT32_MAX } from '../../common/constants';
import {
  IsClassicAddress,
  IsDecimalString,
  IsIssuedCurrencyCode,
  XRP_DROPS_PATTERN,
} from './validators';

/** Fallback for an amount whose `type` is neither XRP nor ISSUED_CURRENCY. */
export class AmountDto {
  @IsIn(['XRP', 'ISSUED_CURRENCY'])
  type!: string;
}

export class XrpAmountDto {
  @Equals('XRP')
  type!: 'XRP';

  @IsString()
  @Matches(XRP_DROPS_PATTERN, { message: 'drops must be a positive integer string of drops' })
  drops!: string;
}

export class IssuedAmountDto {
  @Equals('ISSUED_CURRENCY')
  type!: 'ISSUED_CURRENCY';

  @IsIssuedCurrencyCode()
  currency!: string;

  @IsClassicAddress()
  issuer!: string;

  @IsDecimalString({ positive: true })
  value!: string;
}

export class PaymentIntentDto {
  @Equals('PAYMENT')
  type!: 'PAYMENT';

  @IsClassicAddress()
  account!: string;

  @IsClassicAddress()
  destination!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => AmountDto, {
    keepDiscriminatorProperty: true,
    discriminator: {
      property: 'type',
      subTypes: [
        { value: XrpAmountDto, name: 'XRP' },
        { value: IssuedAmountDto, name: 'ISSUED_CURRENCY' },
      ],
    },
  })
  amount!: XrpAmountDto | IssuedAmountDto;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(UINT32_MAX)
  destinationTag?: number;
}

export class LimitAmountDto {
  @IsIssuedCurrencyCode()
  currency!: string;

  @IsClassicAddress()
  issuer!: string;

  @IsDecimalString({ positive: false })
  value!: string;
}

export class TrustSetIntentDto {
  @Equals('TRUST_SET')
  type!: 'TRUST_SET';

  @IsClassicAddress()
  account!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => LimitAmountDto)
  limitAmount!: LimitAmountDto;
}

export type CreateIntentDto = PaymentIntentDto | TrustSetIntentDto;
