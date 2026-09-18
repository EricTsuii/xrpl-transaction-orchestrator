import { IsString, MinLength } from 'class-validator';

/** The only accepted body of POST /v1/intents/:id/signature. */
export class SignatureDto {
  @IsString()
  @MinLength(1)
  txBlob!: string;
}
