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

O fluxo `login` só aceita uma identidade Google já vinculada; ele nunca cria usuário nem vincula por coincidência de email. O vínculo é iniciado em Configurações e exige a senha local atual. As intenções `signup_owner` e `accept_invite` permanecem fechadas até as fatias específicas de onboarding e convite.

Em produção, `COOKIE_SECURE=true` e callback HTTPS são obrigatórios. A configuração Nginx desativa o access log apenas na rota exata do callback para não gravar `code` ou `state` da query.

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
- `GET /auth/me`
- `POST /auth/logout`
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
