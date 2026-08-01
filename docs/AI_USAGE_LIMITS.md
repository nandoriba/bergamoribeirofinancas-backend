# Consumo e limite mensal da IA

## Contrato do MVP

A unidade bloqueante é uma chamada iniciada ao provedor de IA. A franquia é familiar, compartilhada por todos os membros e reinicia no primeiro instante de cada mês civil em UTC. O limite e o limiar de alerta ficam congelados quando o período é criado; uma alteração de configuração vale para o período seguinte.

A migração não reconstrói chamadas anteriores usando logs históricos, porque isso apresentaria uma medição incompleta como exata. Se ativada no meio do mês, a primeira competência começa no deploy e é operacionalmente parcial; o rollout recomendado é na virada UTC do mês.

Contam na franquia:

- mensagens livres que chegam ao provedor, inclusive `NON_FINANCIAL`;
- timeout, erro do provedor e resposta inválida depois da reserva;
- uma reserva cujo resultado ficou ambíguo após queda do processo.

Não contam:

- autorização e vínculo do Telegram;
- comandos e callbacks, inclusive `/saldo`, `/resumo` e `/desfazer`;
- respostas produzidas localmente;
- mensagens rejeitadas porque a franquia já estava esgotada.

Esgotar a franquia bloqueia somente novas chamadas à IA. Não altera entitlement, sessão, rotas financeiras HTTP, códigos/vínculos do Telegram nem confirmações já pendentes.

## Persistência e concorrência

`AiUsageEvent` é o ledger durável e não guarda prompt nem resposta bruta. `sourceUpdateId` é único. Antes da rede, o worker adquire `Family FOR UPDATE`, revalida vínculo e assinatura, cria os agregados mensais do tenant/membro e reserva uma unidade na mesma transação. O lock é liberado antes de chamar a OpenAI.

Apenas o processo que criou o evento `IN_FLIGHT` pode chamar o provedor. A finalização usa compare-and-swap em `IN_FLIGHT`, de modo que tokens e custo entram nos agregados uma vez. Falha não reembolsa a reserva. Um evento antigo ainda `IN_FLIGHT` vira `AMBIGUOUS` na recuperação e nunca é reenviado automaticamente; o usuário precisa enviar uma nova mensagem. Esse comportamento é conservador porque não é possível saber se o provedor cobrou antes da queda.

`AiTenantMonthlyUsage` aplica a quota familiar. `AiMemberMonthlyUsage` mede o mesmo consumo por autor. Operações financeiras são incrementadas na transação que cria `TelegramFinancialOperation` e no mês UTC da conclusão; uma operação desfeita continua sendo uma operação que foi concluída. Confirmação duplicada não incrementa novamente.

Dois alertas persistentes podem ser emitidos ao grupo: proximidade e esgotamento. Uma reivindicação temporária reduz duplicidade concorrente, mas a entrega pelo Telegram é `at-least-once`: falha mantém o alerta pendente e uma queda após o envio pode causar repetição segura. A restrição operacional de uma única réplica continua válida para o worker completo; consulte `TELEGRAM_TENANT_ACCESS.md`.

## Tokens, custo e auditoria

Cada evento congela provedor, modelo solicitado/usado, versão de pricing, preços de entrada/saída, request ID sanitizado, tokens conhecidos, custo estimado, estado e categoria sanitizada de falha. O cálculo usa decimal e retorna USD com seis casas. Se tokens estiverem ausentes, os totais conhecidos continuam disponíveis com `measurementComplete = false`; ausência nunca é apresentada como medição completa de custo zero.

Os defaults de pricing acompanham o modelo default `gpt-4o-mini`, mas são configuração operacional, não consulta automática ao provedor. Ao trocar modelo ou tabela de preços, atualize juntos:

- `OPENAI_PRICING_VERSION`;
- `OPENAI_INPUT_USD_PER_MILLION_TOKENS`;
- `OPENAI_OUTPUT_USD_PER_MILLION_TOKENS`.

Consulte a [página oficial do modelo](https://developers.openai.com/api/docs/models/gpt-4o-mini) antes de publicar novos valores. A estimativa não gera cobrança por uso no MVP.

O `TelegramMessageLog` continua guardando texto e resposta parseada apenas para depuração e passa por limpeza diária conforme `TELEGRAM_MESSAGE_LOG_RETENTION_DAYS`. No mesmo ciclo, todo `TelegramUpdate` terminal anterior ao TTL é reduzido a um marcador sem texto nem identidade do remetente, inclusive para comandos e registros anteriores à criação do ledger. O `updateId`, o estado e o ledger sem conteúdo bruto permanecem para idempotência, reconciliação, abuso e divergências.

## Configuração

- `TELEGRAM_AI_PLAN_CODE`: identificador auditável do plano único do MVP.
- `TELEGRAM_AI_MONTHLY_MESSAGE_LIMIT`: chamadas mensais por família.
- `TELEGRAM_AI_WARNING_PERCENT`: percentual inteiro entre 50 e 99.
- `OPENAI_PRICING_VERSION`: versão operacional da tabela de preços.
- `OPENAI_INPUT_USD_PER_MILLION_TOKENS`: preço decimal de entrada.
- `OPENAI_OUTPUT_USD_PER_MILLION_TOKENS`: preço decimal de saída.

## API

`GET /telegram/status` retorna grupo, vínculo e o consumo do período. Todos os membros recebem o agregado familiar e somente o próprio agregado; IDs internos e identificadores Telegram não são expostos.

`GET /telegram/usage/members?month=YYYY-MM` exige owner e retorna a discriminação mensal por nome/status de perfil, sem `chatId` nem `tgUserId`. O frontend usa apenas o status agregado; a autorização sempre permanece no backend.

## Validação e rollout

Antes do deploy:

1. revisar os seis valores de configuração;
2. executar `npm run prisma:generate` e `npm run prisma:validate`;
3. aplicar `prisma migrate deploy`;
4. executar `npm test`, `npm run test:integration`, `npm run typecheck` e `npm run build`;
5. confirmar que apenas uma réplica do backend está ativa;
6. monitorar eventos `AMBIGUOUS`, falhas de provider, mensagens bloqueadas e alertas pendentes.

Rollback de aplicação pode parar o worker, mas a migration não deve ser revertida destrutivamente: os agregados e o ledger são dados de auditoria. Reimplante a build compatível ou corrija adiante.
