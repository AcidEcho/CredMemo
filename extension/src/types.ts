export interface LoginItem {
  label: string;
  username: string;
  password: string;
}

export type OtpType = 'totp' | 'hotp' | 'battle' | 'steam' | 'hex' | 'hhex';
export type OtpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512' | 'GOST3411_2012_256' | 'GOST3411_2012_512';

export interface TotpItem {
  label: string;
  secret: string;
  digits: number;
  period: number;
  algorithm: OtpAlgorithm;
  type: OtpType;
  counter?: number;
}

export interface Credential {
  title: string;
  url: string;
  notes: string;
  logins: LoginItem[];
  totps: TotpItem[];
}

export interface Entry extends Credential {
  id: string;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface Sealed {
  iv: string;
  ciphertext: string;
}

export interface Kdf {
  algorithm: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
}

export interface VaultEnvelope {
  format: 'credmemo-vault';
  version: 2;
  id: string;
  revision: number;
  kdf: Kdf;
  wrappedKey: Sealed;
  data: Sealed;
}

export interface BackupEnvelope {
  format: 'credmemo-backup';
  version: 2;
  kdf: Kdf;
  data: Sealed;
}

export interface VaultSession {
  vaultId: string;
  key: string;
  lastActive: number;
}

export interface StorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export class VaultError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = 'VaultError';
  }
}

export function fail(code: string): never {
  throw new VaultError(code);
}
