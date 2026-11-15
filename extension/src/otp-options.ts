import { fail, type OtpAlgorithm, type OtpType, type TotpItem } from './types.ts';

export const OTP_TYPES: OtpType[] = ['totp', 'hotp', 'steam', 'battle', 'hex', 'hhex'];
export const OTP_ALGORITHMS: OtpAlgorithm[] = ['SHA1', 'SHA256', 'SHA512', 'GOST3411_2012_256', 'GOST3411_2012_512'];
export const counterBased = (type?: string) => type === 'hotp' || type === 'hhex';

export function otpOptions(raw: Record<string, unknown>): Pick<TotpItem, 'digits' | 'period' | 'algorithm' | 'type' | 'counter'> {
  const type = raw.type ?? 'totp', algorithm = raw.algorithm ?? 'SHA1';
  const digits = Number(raw.digits ?? 6), period = Number(raw.period ?? 30);
  if (!OTP_TYPES.includes(type as OtpType) || !OTP_ALGORITHMS.includes(algorithm as OtpAlgorithm)
    || !Number.isInteger(digits) || digits < 1 || digits > 10
    || !Number.isSafeInteger(period) || period < 1) fail('invalid_totp');
  const options = { type: type as OtpType, digits: type === 'steam' ? 5 : type === 'battle' ? 8 : digits, period, algorithm: algorithm as OtpAlgorithm };
  if (!counterBased(String(type))) return options;
  const counter = Number(raw.counter ?? 0);
  if (!Number.isSafeInteger(counter) || counter < 0) fail('invalid_totp');
  return { ...options, counter };
}
