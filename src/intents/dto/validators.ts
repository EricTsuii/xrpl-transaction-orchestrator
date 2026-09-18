import { registerDecorator, ValidationOptions } from 'class-validator';
import { isValidClassicAddress } from 'xrpl';
import { DECIMAL_VALUE_MAX_LENGTH } from '../../common/constants';

export const XRP_DROPS_PATTERN = /^[1-9][0-9]{0,29}$/;
export const CURRENCY_CODE_PATTERN = /^[A-Z0-9]{3}$/;
export const DECIMAL_VALUE_PATTERN = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/** A classic r-address. X-addresses are rejected. */
export function IsClassicAddress(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyName) => {
    registerDecorator({
      name: 'isClassicAddress',
      target: target.constructor,
      propertyName: propertyName as string,
      options: { message: '$property must be a classic XRPL address', ...options },
      validator: {
        validate: (value: unknown) => typeof value === 'string' && isValidClassicAddress(value),
      },
    });
  };
}

/** A three-character currency code other than XRP. */
export function IsIssuedCurrencyCode(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyName) => {
    registerDecorator({
      name: 'isIssuedCurrencyCode',
      target: target.constructor,
      propertyName: propertyName as string,
      options: {
        message: '$property must be a three-character currency code other than XRP',
        ...options,
      },
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && CURRENCY_CODE_PATTERN.test(value) && value !== 'XRP',
      },
    });
  };
}

/**
 * A plain decimal string of at most 64 characters. Checked as text only: the
 * value never becomes a JavaScript number.
 */
export function IsDecimalString(
  { positive }: { positive: boolean },
  options?: ValidationOptions,
): PropertyDecorator {
  return (target, propertyName) => {
    registerDecorator({
      name: positive ? 'isPositiveDecimalString' : 'isNonNegativeDecimalString',
      target: target.constructor,
      propertyName: propertyName as string,
      options: {
        message: `$property must be a ${positive ? 'positive' : 'non-negative'} decimal string of at most ${DECIMAL_VALUE_MAX_LENGTH} characters`,
        ...options,
      },
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' &&
          value.length <= DECIMAL_VALUE_MAX_LENGTH &&
          DECIMAL_VALUE_PATTERN.test(value) &&
          (!positive || /[1-9]/.test(value)),
      },
    });
  };
}
