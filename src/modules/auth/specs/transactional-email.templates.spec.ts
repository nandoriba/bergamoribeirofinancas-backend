import { describe, expect, it } from 'vitest';

import { renderTransactionalEmail } from '../transactional-email.templates';

const base = {
  outboxId: 'outbox-1',
  tokenId: '11111111-1111-4111-8111-111111111111',
  recipient: 'owner@example.com',
  webOrigin: 'https://app.example.com',
  publicApiOrigin: 'https://api.example.com',
  verificationTtlMinutes: 15,
  resetTtlMinutes: 30,
  supportEmail: 'support@example.com',
};

describe('renderTransactionalEmail', () => {
  it('renders the six-digit challenge without putting it in a URL', () => {
    const message = renderTransactionalEmail({
      ...base,
      payload: { kind: 'email_verification', code: '001234' },
    });

    expect(message).toMatchObject({
      to: 'owner@example.com',
      idempotencyKey: 'financeiro-outbox-outbox-1',
      subject: 'Seu código de verificação',
    });
    expect(message.text).toContain('Código: 001234');
    expect(message.text).toContain('https://app.example.com/verificar-email?challenge=');
    expect(message.text).not.toContain('code=001234');
    expect(message.html).toContain('001234');
    expect(message.html).toContain('support@example.com');
  });

  it('renders a one-time reset exchange through the public API', () => {
    const resetToken = '11111111-1111-4111-8111-111111111111.A'.padEnd(80, 'A');
    const message = renderTransactionalEmail({
      ...base,
      payload: { kind: 'password_reset', resetToken },
    });

    expect(message.idempotencyKey).toBe('financeiro-outbox-outbox-1');
    expect(message.text).toContain(
      `https://api.example.com/auth/password-reset/continue?token=${resetToken}`,
    );
    expect(message.text).toContain('30 minutos');
    expect(message.html).toContain('Criar nova senha');
  });

  it('usa a rota tokenless fixa do convite e injeta somente o challenge persistido', () => {
    const message = renderTransactionalEmail({
      ...base,
      payload: {
        kind: 'email_verification',
        code: '123456',
        continuationPath: '/convite/verificacao',
      },
    });

    expect(message.text).toContain(
      'https://app.example.com/convite/verificacao?challenge=11111111-1111-4111-8111-111111111111',
    );
    expect(message.text).not.toMatch(/\/convite\/[A-Za-z0-9_-]{43}/);

    const unsafe = renderTransactionalEmail({
      ...base,
      payload: {
        kind: 'email_verification',
        code: '123456',
        continuationPath: 'https://evil.example/steal',
      } as never,
    });
    expect(unsafe.text).toContain('https://app.example.com/verificar-email?challenge=');
    expect(unsafe.text).not.toContain('evil.example');
  });

  it('escapes data interpolated into HTML and omits absent support contacts', () => {
    const message = renderTransactionalEmail({
      ...base,
      supportEmail: '<script>alert(1)</script>@example.com',
      payload: { kind: 'email_verification', code: '123456' },
    });
    const withoutSupport = renderTransactionalEmail({
      ...base,
      supportEmail: undefined,
      payload: { kind: 'email_verification', code: '123456' },
    });

    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;');
    expect(withoutSupport.text).not.toContain('Precisa de ajuda?');
  });
});
