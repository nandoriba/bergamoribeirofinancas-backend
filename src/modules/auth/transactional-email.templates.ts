import type { EmailOutboxPayload } from './action-token-crypto.service';
import type { TransactionalEmailMessage } from './transactional-email.provider';

interface TemplateInput {
  outboxId: string;
  tokenId: string;
  recipient: string;
  payload: EmailOutboxPayload;
  webOrigin: string;
  publicApiOrigin: string;
  verificationTtlMinutes: number;
  resetTtlMinutes: number;
  supportEmail?: string;
}

export function renderTransactionalEmail(input: TemplateInput): TransactionalEmailMessage {
  if (input.payload.kind === 'email_verification') {
    const verificationUrl = new URL('/verificar-email', input.webOrigin);
    verificationUrl.searchParams.set('challenge', input.tokenId);
    const code = input.payload.code;
    const support = supportSentence(input.supportEmail);

    return {
      to: input.recipient,
      idempotencyKey: `financeiro-outbox-${input.outboxId}`,
      subject: 'Seu código de verificação',
      text: [
        'Confirme seu e-mail para concluir o cadastro.',
        '',
        `Código: ${code}`,
        `Este código expira em ${input.verificationTtlMinutes} minutos.`,
        `Continuar: ${verificationUrl.toString()}`,
        '',
        'Se você não iniciou este cadastro, ignore esta mensagem.',
        support,
      ]
        .filter(Boolean)
        .join('\n'),
      html: emailLayout(
        'Confirme seu e-mail',
        `<p>Use o código abaixo para concluir o cadastro.</p>
         <p style="font-size:32px;letter-spacing:0.18em;font-weight:700;margin:24px 0">${escapeHtml(code)}</p>
         <p>Ele expira em ${input.verificationTtlMinutes} minutos.</p>
         <p><a href="${escapeHtml(verificationUrl.toString())}">Abrir a página de verificação</a></p>
         <p style="color:#5d6470">Se você não iniciou este cadastro, ignore esta mensagem.</p>
         ${support ? `<p style="color:#5d6470">${escapeHtml(support)}</p>` : ''}`,
      ),
    };
  }

  const resetUrl = new URL('/auth/password-reset/continue', input.publicApiOrigin);
  resetUrl.searchParams.set('token', input.payload.resetToken);
  const support = supportSentence(input.supportEmail);

  return {
    to: input.recipient,
    idempotencyKey: `financeiro-outbox-${input.outboxId}`,
    subject: 'Redefinição de senha',
    text: [
      'Recebemos uma solicitação para redefinir sua senha.',
      '',
      `Criar uma nova senha: ${resetUrl.toString()}`,
      `Este link expira em ${input.resetTtlMinutes} minutos e só pode ser usado uma vez.`,
      '',
      'Se você não fez esta solicitação, ignore esta mensagem.',
      support,
    ]
      .filter(Boolean)
      .join('\n'),
    html: emailLayout(
      'Redefina sua senha',
      `<p>Recebemos uma solicitação para criar uma nova senha.</p>
       <p style="margin:24px 0"><a href="${escapeHtml(resetUrl.toString())}">Criar nova senha</a></p>
       <p>O link expira em ${input.resetTtlMinutes} minutos e só pode ser usado uma vez.</p>
       <p style="color:#5d6470">Se você não fez esta solicitação, ignore esta mensagem.</p>
       ${support ? `<p style="color:#5d6470">${escapeHtml(support)}</p>` : ''}`,
    ),
  };
}

function supportSentence(supportEmail?: string): string {
  return supportEmail ? `Precisa de ajuda? Escreva para ${supportEmail}.` : '';
}

function emailLayout(title: string, content: string): string {
  return `<!doctype html>
<html lang="pt-BR">
  <body style="margin:0;background:#f4f1ea;color:#17233d;font-family:Arial,sans-serif">
    <main style="max-width:560px;margin:0 auto;padding:32px 20px">
      <section style="background:#ffffff;border:1px solid #d8d4ca;padding:32px">
        <p style="margin:0 0 8px;text-transform:uppercase;letter-spacing:.12em;font-size:12px">Finanças em família</p>
        <h1 style="font-family:Georgia,serif;font-size:28px;margin:0 0 20px">${escapeHtml(title)}</h1>
        ${content}
      </section>
    </main>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
