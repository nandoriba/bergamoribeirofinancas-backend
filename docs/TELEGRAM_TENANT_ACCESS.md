# Telegram por tenant e grupo

## Regras de acesso

- Cada família possui no máximo um grupo ativo. Somente o owner gera e consome o código de autorização.
- Autorizar outro grupo substitui o anterior na mesma transação, revoga os vínculos daquele chat e cancela confirmações pendentes.
- Cada membro ativo vincula o próprio usuário do Telegram ao próprio perfil dentro do grupo autorizado. `chatId`, `tgUserId` e identificadores internos não são expostos pela API de status.
- Gerar um novo vínculo pessoal revoga a identidade Telegram anterior e suas confirmações pendentes. Um índice parcial mantém no máximo uma identidade ativa por perfil e grupo; a migration preserva somente o vínculo ativo mais recente caso encontre legado duplicado.
- O vínculo persiste `familyId` e usa chaves estrangeiras compostas para o grupo e o perfil; um vínculo entre famílias diferentes é recusado também pelo PostgreSQL.
- Toda leitura, chamada à IA, criação, confirmação e desfazimento reavalia a mesma `SubscriptionAccessPolicy` fail-closed usada pelo acesso HTTP. Apenas `active` e `past_due` são aceitos.
- Uma mensagem que aguardou na fila não conserva a autorização antiga. Cancelamento, expiração, inativação, troca de grupo ou revogação de vínculo ocorridos antes do processamento impedem a IA e as mutações seguintes.
- Criação de confirmações, mutações e undo adquirem o lock da `Family` antes da última reavaliação. Os fluxos de cancelamento, webhook, inativação, relink e troca de grupo usam o mesmo lock, e conflitos transitórios são repetidos; assim, quem revoga primeiro impede tanto uma nova confirmação quanto o commit financeiro posterior.
- Quando um grupo e remetente válidos pertencem a um tenant bloqueado, o bot não chama a IA e orienta o owner a regularizar ou iniciar novo checkout no app. Grupo ou remetente desconhecido não recebe informação sobre a assinatura.

## Restrição operacional: uma réplica

O MVP exige **exatamente uma réplica da API `financeiro-api`**. Não execute o backend em cluster e não use `docker compose up --scale backend=...`.

O worker atual mantém uma única fila serial em memória (`Promise`). Uma chamada lenta à IA bloqueia temporariamente todos os chats, e duas réplicas poderiam disputar o mesmo `TelegramUpdate`, chamar a IA mais de uma vez e produzir respostas concorrentes. O banco continua sendo a fonte de verdade para updates e idempotência financeira, mas isso não torna o worker seguro para múltiplos consumidores.

`TelegramService.recoverStuckUpdates` apenas reenfileira updates persistidos que ficaram presos. Ele não concede acesso, não calcula saldo e não substitui a reavaliação da assinatura. Monitore falhas e atraso desse cron separadamente.

Antes de escalar horizontalmente, substitua a fila em memória por claim/fila distribuída com lease e serialização por chat. A serialização por chat, em vez da fila global, também evita que IA lenta de uma família bloqueie as demais.
