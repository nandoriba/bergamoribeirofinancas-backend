import { BadRequestException } from '@nestjs/common';

const BCRYPT_MAX_PASSWORD_BYTES = 72;

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function assertPasswordFitsBcrypt(password: string): void {
  if (Buffer.byteLength(password, 'utf8') > BCRYPT_MAX_PASSWORD_BYTES) {
    throw new BadRequestException('A senha excede o tamanho máximo permitido.');
  }
}

export function maskEmail(email: string): string {
  const separator = email.lastIndexOf('@');
  if (separator <= 0) return '***';

  const local = email.slice(0, separator);
  const domain = email.slice(separator + 1);
  const visibleLocal = local.slice(0, Math.min(2, local.length));
  const domainParts = domain.split('.');
  const domainName = domainParts[0] ?? '';
  const suffix = domainParts.length > 1 ? `.${domainParts.slice(1).join('.')}` : '';
  const visibleDomain = domainName.slice(0, 1);

  return `${visibleLocal}${'*'.repeat(Math.max(3, local.length - visibleLocal.length))}@${visibleDomain}***${suffix}`;
}
