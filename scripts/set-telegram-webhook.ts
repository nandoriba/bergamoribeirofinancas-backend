import { existsSync } from 'node:fs';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const token = process.env.TELEGRAM_BOT_TOKEN;
const url = process.env.TELEGRAM_PUBLIC_WEBHOOK_URL;
const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET;

if (!token || !url || !secretToken) {
  throw new Error('Configure TELEGRAM_BOT_TOKEN, TELEGRAM_PUBLIC_WEBHOOK_URL e TELEGRAM_WEBHOOK_SECRET.');
}

async function main() {
  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url,
      secret_token: secretToken,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false,
    }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(`Falha ao registrar webhook: ${JSON.stringify(payload)}`);
  }

  console.log(`Webhook registrado em ${url}`);
}

void main();
