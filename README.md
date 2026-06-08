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

Em `NODE_ENV=development`, o CORS aceita automaticamente origens `http://127.0.0.1:<porta>` e `http://localhost:<porta>`. Isso evita falha de login quando o Vite muda de porta porque `8181` já estava ocupada.

## Banco Local

Use o database lógico do projeto: `bergamoribeirofinancas_db`. Não use o database do Psicocomportamento para tabelas do financeiro.

O seed cria apenas estrutura inicial: família, admin local, perfil, contas e categorias. Lançamentos demonstrativos e dados de mock não são versionados.

## Endpoints Principais

- `GET /health`
- `POST /auth/login`
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
