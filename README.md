# Casa Ribeiro Finanças Backend

API NestJS + Prisma + PostgreSQL do sistema financeiro familiar Casa Ribeiro.

## Setup

```bash
npm install
npm run prisma:generate
npm run prisma:migrate -- --name init
npm run prisma:seed
npm run dev
```

API local: `http://127.0.0.1:8180`.

Crie um `.env` local a partir de `.env.example`. O arquivo `.env` é ignorado pelo Git para não versionar senhas ou dados locais.

Em `NODE_ENV=development`, o CORS aceita origens loopback. As mutações de autenticação validam `Origin` de forma estrita contra `WEB_ORIGIN`; se a porta do Vite mudar, atualize essa variável antes de entrar ou iniciar o Google OAuth.

## Google OpenID Connect

O login Google usa Authorization Code Flow no backend, PKCE S256, `state`, `nonce` e cookie de navegador transitório. Crie clientes Google diferentes para desenvolvimento e produção e registre exatamente o callback do ambiente, por exemplo `http://127.0.0.1:8180/auth/google/callback` no desenvolvimento. Depois configure `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, um `OAUTH_ATTEMPT_SECRET` independente e ative `GOOGLE_OAUTH_ENABLED=true`.

O fluxo `login` só aceita uma identidade Google já vinculada; ele nunca cria usuário nem vincula por coincidência de email. O vínculo é iniciado em Configurações e exige a senha local atual. `signup_owner` só abre com `OWNER_SIGNUP_ENABLED=true`, persiste nomes e aceite legal na tentativa server-side e cria tenant/owner/identidade em uma única transação. `accept_invite` exige convite ativo, entitlement vigente e aprovação posterior do owner.

Em produção, `COOKIE_SECURE=true` e callback HTTPS são obrigatórios. A configuração Nginx desativa logs apenas nas rotas exatas do callback e da continuação do reset, evitando gravar segredos presentes na query.

## Onboarding e e-mail transacional

O cadastro local cria família, owner, perfil, aceite legal, desafio de verificação e outbox no mesmo commit. Até o OTP, o usuário usa placeholder interno e não reserva globalmente o e-mail solicitado. O código de seis dígitos fica armazenado somente como HMAC; a cópia necessária ao envio fica cifrada na outbox e é apagada após entrega ou descarte. O worker envia pelo Resend depois do commit, com chave de idempotência, quota persistente por destinatário e retries limitados.

Configure `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM`, `PUBLIC_API_ORIGIN`, `SUPPORT_EMAIL` e segredos independentes em `ACTION_TOKEN_SECRET` e `EMAIL_OUTBOX_SECRET`. Recuperação de senha usa link de uso único, cookie transitório HttpOnly e incrementa `authVersion`, invalidando sessões anteriores. O fluxo também permite que uma conta originalmente Google-only defina uma senha.

Owners novos ficam com `requiredAction=payment`; o guard global libera somente sessão, logout e as rotas de cobrança explicitamente autorizadas. O checkout mensal hospedado da AbacatePay usa somente cartão e não altera entitlement pelo retorno do navegador nem por reconciliação `PAID`. Webhook, paywall derivado, cancelamento e retenção estão implementados em modo fail-closed; eventos positivos ficam em quarentena até o HMAC e a fronteira mensal serem comprovados no sandbox. Como a documentação do provider não fixa quando um checkout pendente expira, o sandbox também precisa provar que ele deixa de aceitar pagamento dentro do TTL local (ou fornecer invalidação segura). `OWNER_SIGNUP_ENABLED` permanece `false` até esses gates. Consulte [docs/ABACATEPAY_CHECKOUT.md](docs/ABACATEPAY_CHECKOUT.md) e [docs/ABACATEPAY_WEBHOOK_PAYWALL_RETENTION.md](docs/ABACATEPAY_WEBHOOK_PAYWALL_RETENTION.md). Termos e privacidade incluídos no frontend são uma versão operacional preliminar e exigem revisão jurídica antes da ativação.

## Telegram

Cada família autoriza exatamente um grupo e cada membro vincula o próprio Telegram ao próprio perfil. O worker reavalia o mesmo entitlement fail-closed do HTTP antes da IA e das mutações. O MVP exige **uma única réplica da API** porque a fila é serial e mantida em memória; não escale o serviço `backend` horizontalmente. Consulte [docs/TELEGRAM_TENANT_ACCESS.md](docs/TELEGRAM_TENANT_ACCESS.md) e [docs/AI_USAGE_LIMITS.md](docs/AI_USAGE_LIMITS.md).

## Banco Local

Use o database lógico local do projeto: `bergamoribeirofinancas_db`. Em produção, na VPS compartilhada, use `db_financeiro` com o usuário dedicado `financeiro_user`. Não use o database do Psicocomportamento para tabelas do financeiro.

O seed cria apenas estrutura inicial: família, admin local, perfil, contas e categorias. Lançamentos demonstrativos e dados de mock não são versionados.

## Endpoints Principais

- `GET /health`
- `POST /auth/login`
- `POST /auth/google/start`
- `GET /auth/google/callback`
- `GET /auth/methods`
- `POST /auth/google/unlink`
- `GET /auth/onboarding/config`
- `POST /auth/signup/owner`
- `POST /auth/email-verification/confirm`
- `POST /auth/email-verification/resend`
- `POST /auth/password-reset/request`
- `GET /auth/password-reset/continue`
- `POST /auth/password-reset/confirm`
- `GET /auth/me`
- `POST /auth/logout`
- `GET /payments/subscription`
- `POST /payments/checkout`
- `POST /payments/subscription/reconcile`
- `POST /payments/subscription/cancel`
- `POST /payments/webhooks/abacatepay`
- `GET /telegram/status`
- `POST /telegram/auth-codes/group`
- `POST /telegram/auth-codes/member`
- `POST /member-invites`
- `POST /member-approvals/:id/approve`
- `GET /dashboard?family=true`
- `CRUD /accounts`
- `CRUD /categories`
- `CRUD /transactions`
- `POST /imports/preview`
- `POST /imports/confirm`
- `CRUD /recurring`
- `CRUD /installments`
- `GET /reports/monthly`

A solicitação de reset persiste primeiro uma fila genérica cifrada; a busca de conta e a emissão atômica de token/outbox acontecem somente no worker recuperável.
