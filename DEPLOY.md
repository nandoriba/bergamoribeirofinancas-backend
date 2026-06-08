# Deploy — Sistema Financeiro

Procedimento para subir o sistema (back + front + Postgres) em VPS Hostinger,
seguindo o mesmo padrão do Psicomportamento (Docker + GHCR + GitHub Actions + nginx host).

## 1. Provisionar a VPS (uma vez)

Pré-requisitos na VPS Ubuntu:

```bash
# Docker + compose plugin
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# nginx + certbot
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
```

Estrutura na VPS:

```bash
sudo mkdir -p /app/backups
sudo chown -R $USER:$USER /app
cd /app
```

Copiar arquivos iniciais (uma vez, antes do primeiro deploy):

```bash
# Do seu desktop, copiar via scp:
scp bergamoribeirofinancas-backend/docker-compose.yml      vps:/app/
scp bergamoribeirofinancas-backend/.env.production.example vps:/app/.env
scp bergamoribeirofinancas-backend/deploy/backup-postgres.sh vps:/app/scripts/
scp bergamoribeirofinancas-backend/deploy/nginx-financas.conf vps:/etc/nginx/sites-available/financas.conf
```

Editar `/app/.env` na VPS preenchendo `POSTGRES_PASSWORD`, `JWT_SECRET`, `WEB_ORIGIN`, etc.
`BACKEND_TAG` e `FRONTEND_TAG` ficam como `latest` no início — os workflows atualizam.

## 2. Configurar DNS e TLS

Aponte `financas.seu-dominio.com` (A record) para o IP da VPS, então:

```bash
sudo ln -s /etc/nginx/sites-available/financas.conf /etc/nginx/sites-enabled/
sudo certbot --nginx -d financas.seu-dominio.com
sudo systemctl reload nginx
```

## 3. Configurar GitHub

Em cada repo (`bergamoribeirofinancas-backend` e `bergamoribeirofinancas-frontend`),
adicionar **Secrets** em Settings → Secrets and variables → Actions:

| Secret | Descrição |
|---|---|
| `VPS_HOST` | IP ou hostname da VPS |
| `VPS_PORT` | porta SSH (omitir → 22) |
| `VPS_USER` | usuário SSH |
| `VPS_SSH_KEY` | chave privada SSH (PEM, multilinha) |
| `VPS_APP_DIR` | `/app` |
| `GHCR_USERNAME` | seu usuário GitHub |
| `GHCR_PAT` | Personal Access Token com escopo `read:packages` |

Apenas no repo **frontend**, adicionar também:

| Secret | Valor exemplo |
|---|---|
| `VITE_API_BASE_URL_PRODUCTION` | `https://financas.seu-dominio.com/api` |

## 4. Primeiro deploy

Em cada repo, push para `main` dispara o workflow. Ele:

1. Roda lint + typecheck + testes.
2. Builda a imagem Docker.
3. Push para `ghcr.io/<owner>/bergamoribeirofinancas-{backend,frontend}`.
4. SSH na VPS, atualiza `BACKEND_TAG` ou `FRONTEND_TAG` em `/app/.env`.
5. `docker compose pull <serviço> && docker compose up -d <serviço>`.
6. Healthcheck pós-deploy.

Ordem recomendada no primeiro deploy: **backend primeiro** (sobe Postgres + roda migrations), depois **frontend**.

## 5. Backup diário

```bash
chmod +x /app/scripts/backup-postgres.sh
sudo crontab -e
# adicionar:
0 3 * * * /app/scripts/backup-postgres.sh >> /var/log/financas-backup.log 2>&1
```

Restore (teste eventualmente):

```bash
gunzip -c /app/backups/financas-AAAAMMDD-HHMMSS.sql.gz \
  | docker compose -f /app/docker-compose.yml exec -T postgres \
    psql -U $POSTGRES_USER -d $POSTGRES_DB
```

## 6. Rollback

Cada deploy guarda imagem com tag = SHA. Para voltar:

```bash
ssh vps
cd /app
sed -i "s/^BACKEND_TAG=.*/BACKEND_TAG=<sha-anterior>/" .env
docker compose pull backend && docker compose up -d backend
```
