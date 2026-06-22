# Deploy — Sistema Financeiro

Procedimento para subir o sistema financeiro na mesma VPS Hostinger do
Psicomportamento, reaproveitando o Postgres existente e mantendo o deploy do
financeiro isolado em `/app/financeiro`.

## 1. Topologia

Serviços já existentes na VPS:

```text
/app/docker-compose.yml        # Stack do Psicocomportamento
postgres_db                    # Postgres compartilhado
app_internal                   # Rede Docker compartilhada
```

Serviços do financeiro:

```text
/app/financeiro/docker-compose.yml
/app/financeiro/.env
financeiro-api                 # 127.0.0.1:8180
financeiro-web                 # 127.0.0.1:8181
```

Banco do financeiro no Postgres compartilhado:

```text
Database: db_financeiro
User: financeiro_user
Host Docker: postgres_db
```

Não copie o compose do financeiro para `/app/docker-compose.yml`. Esse arquivo
pertence ao Psicocomportamento.

## 2. Provisionar diretório

Na VPS:

```bash
mkdir -p /app/financeiro/backups /app/financeiro/scripts
```

Do desktop, copiar os arquivos iniciais:

```bash
scp bergamoribeirofinancas-backend/.env.production.example fernando-vps:/app/financeiro/.env
scp bergamoribeirofinancas-backend/docker-compose.yml fernando-vps:/app/financeiro/docker-compose.yml
scp bergamoribeirofinancas-backend/deploy/backup-postgres.sh fernando-vps:/app/financeiro/scripts/backup-postgres.sh
```

Editar `/app/financeiro/.env` na VPS e preencher `GHCR_OWNER`,
`POSTGRES_PASSWORD`, `DATABASE_URL`, `JWT_SECRET`, usuário admin inicial e tags.

## 3. Criar banco e usuário

Execute no Postgres compartilhado com um usuário administrador do banco:

```sql
CREATE ROLE financeiro_user LOGIN PASSWORD 'trocar-em-producao';
CREATE DATABASE db_financeiro OWNER financeiro_user;
GRANT ALL PRIVILEGES ON DATABASE db_financeiro TO financeiro_user;
```

O `DATABASE_URL` no `/app/financeiro/.env` deve seguir este formato:

```text
DATABASE_URL=postgresql://financeiro_user:SENHA@postgres_db:5432/db_financeiro?schema=public
```

## 4. Configurar GitHub

Nos dois repositórios (`bergamoribeirofinancas-backend` e
`bergamoribeirofinancas-frontend`), configurar:

| Secret | Valor |
|---|---|
| `VPS_HOST` | IP ou hostname da VPS |
| `VPS_PORT` | porta SSH, geralmente `22` |
| `VPS_USER` | usuário SSH |
| `VPS_SSH_KEY` | chave privada SSH |
| `VPS_APP_DIR` | `/app/financeiro` |
| `GHCR_USERNAME` | usuário GitHub |
| `GHCR_PAT` | token com `read:packages` |

Apenas no frontend:

| Secret ou variable | Valor |
|---|---|
| `VITE_API_BASE_URL_PRODUCTION` | `https://api.bergamoribeirofinancas.com.br` |

Os workflows falham se `VPS_APP_DIR` for diferente de `/app/financeiro`, para
evitar sobrescrever a stack do Psicocomportamento.

## 5. Primeiro deploy

Ordem recomendada:

1. Rodar o workflow do backend.
2. Confirmar healthcheck local na VPS:

```bash
curl -fsS http://127.0.0.1:8180/health
```

3. Rodar o workflow do frontend.
4. Confirmar frontend local na VPS:

```bash
curl -fsS http://127.0.0.1:8181
```

Os workflows usam:

```bash
docker compose -p financeiro -f /app/financeiro/docker-compose.yml up -d <servico>
```

Não use `--remove-orphans` nessa stack durante deploy automatizado.

## 6. NGINX e TLS

Domínios planejados:

```text
bergamoribeirofinancas.com.br      -> 127.0.0.1:8181
api.bergamoribeirofinancas.com.br  -> 127.0.0.1:8180
```

Depois que o DNS apontar para a VPS, habilite uma configuração nginx para esses
dois hosts e rode Certbot:

```bash
sudo certbot --nginx -d bergamoribeirofinancas.com.br -d api.bergamoribeirofinancas.com.br
sudo systemctl reload nginx
```

## 7. Backup diário

Na VPS:

```bash
chmod +x /app/financeiro/scripts/backup-postgres.sh
```

Agendar no cron:

```bash
0 3 * * * APP_DIR=/app/financeiro /app/financeiro/scripts/backup-postgres.sh >> /var/log/financas-backup.log 2>&1
```

Restore:

```bash
gunzip -c /app/financeiro/backups/financas-AAAAMMDD-HHMMSS.sql.gz \
  | docker exec -i postgres_db psql -U financeiro_user -d db_financeiro
```

## 8. Rollback

Cada deploy usa tag igual ao SHA do commit. Para voltar:

```bash
cd /app/financeiro
sed -i "s/^BACKEND_TAG=.*/BACKEND_TAG=<sha-anterior>/" .env
docker compose -p financeiro -f /app/financeiro/docker-compose.yml pull backend
docker compose -p financeiro -f /app/financeiro/docker-compose.yml up -d backend
```
