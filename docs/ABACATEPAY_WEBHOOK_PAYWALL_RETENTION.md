# Webhook, paywall e retenção da AbacatePay

## Estado de rollout

A infraestrutura da Fatia 8 está implementada em modo fail-closed. Os flags abaixo permanecem `false` por padrão:

- `ABACATEPAY_ENABLED` controla chamadas ao provider;
- `ABACATEPAY_WEBHOOK_ENABLED` expõe o endpoint;
- `ABACATEPAY_WEBHOOK_CONTRACT_CONFIRMED` declara que a autenticação foi comprovada com evento real do ambiente;
- `ABACATEPAY_PENDING_EXPIRY_CONTRACT_CONFIRMED` declara que o sandbox comprovou expiração dentro do TTL local ou uma invalidação segura do checkout pendente;
- `ABACATEPAY_ENTITLEMENT_ENABLED` é o gate reservado para uma versão positiva comprovada;
- `OWNER_SIGNUP_ENABLED` abre o cadastro público.

O parser, a persistência idempotente e o paywall podem ser publicados com entitlement desligado. Nesta build, `subscription.completed`, `subscription.renewed` e `subscription.payment_failed` são sempre quarentenados: o sistema pode vincular de modo monotônico um `subs_...` à assinatura local fortemente correlacionada, mas não inventa `accessPaidThrough`, tolerância ou acesso. O validador de ambiente rejeita `ABACATEPAY_ENTITLEMENT_ENABLED=true` enquanto não existir uma versão comprovada na allowlist do código. O retorno do checkout e uma reconciliação que encontre `PAID` também nunca concedem acesso.

## Endpoint e autenticação

O endpoint público é `POST /payments/webhooks/abacatepay`. Ele fica fora do JWT e do paywall, limitado a 60 requisições por minuto, e exige simultaneamente:

1. `webhookSecret` na query exatamente igual ao segredo exclusivo cadastrado para aquele ambiente;
2. `X-Webhook-Signature` igual ao HMAC-SHA-256 em Base64 calculado sobre os bytes brutos exatos do corpo com o mesmo segredo;
3. envelope com `apiVersion: 2` e `devMode` coerente com o ambiente da aplicação.

Secret, assinatura e HMAC usam comparação timing-safe. A autenticação ocorre antes do parse de JSON, e o parser dedicado preserva os bytes recebidos sem serializar novamente o objeto.

A documentação publicada da AbacatePay é contraditória ao também apresentar uma chave globalmente conhecida para a assinatura. Uma chave pública não autentica o remetente. Este sistema aceita somente o `registered_secret`; `ABACATEPAY_WEBHOOK_HMAC_MODE` não possui outro modo válido. Mantenha `ABACATEPAY_WEBHOOK_CONTRACT_CONFIRMED=false` até um webhook originado pelo sandbox comprovar que o provider realmente assina com o segredo cadastrado.

No Nginx, a `location` exata do webhook desliga `access_log` e restringe `error_log`, pois a URI possui segredo. Variantes com barra final ou sufixo são rejeitadas com `404` dentro de uma `location` que também não registra a URI; assim, uma URL cadastrada incorretamente não cai no log geral com o segredo. A aplicação nunca registra query completa, segredo, assinatura, corpo bruto ou payload integral; persiste apenas o hash SHA-256 do corpo e fatos normalizados.

## Atomicidade e idempotência

Cada evento usa o ID do provider como chave idempotente e o hash do corpo como proteção contra reuso conflitante. O processamento ocorre em transação `Serializable`, com retentativa limitada para conflito de serialização. Um ID repetido com o mesmo corpo é reconhecido sem reaplicar efeitos; o mesmo ID com outro hash retorna conflito e exige incidente operacional.

A correlação aceita apenas identificadores fortes de assinatura, checkout, pagamento ou `externalId`. Customer isolado nunca escolhe tenant. Um `externalId` não pode vincular sozinho um `bill_...` ainda desconhecido: o evento fica em quarentena recuperável até que a reconciliação local grave o checkout, e uma divergência posterior é terminal. Um `subscription.renewed` autenticado pode registrar a associação histórica do novo `bill_...` à assinatura; isso permite correlacionar um refund/dispute posterior cujo payload não repete o `externalId`, sem conceder entitlement pelo evento positivo. Eventos de assinatura antiga permanecem associados ao histórico e não alteram o ponteiro atual da família. Registros interrompidos em `received` ou `failed` são recuperados e reprocessados atomicamente. Um `subscription.cancelled` que chegue antes do vínculo imutável do `providerSubscriptionId` fica em quarentena com `CORRELATION_NOT_FOUND`, mas a reentrega pode ser reprocessada depois que outro evento fortemente correlacionado concluir o vínculo. Quarentenas por divergência de contrato ou identidade continuam terminais.

Eventos `subscription.cancelled` revogam acesso no `canceledAt` autoritativo do provider e confirmam `providerStatus=CANCELLED`. O payload documentado de checkout não informa quando o refund/dispute ocorreu; portanto, `checkout.refunded` e `checkout.disputed` usam o horário autenticado de recebimento como início conservador da retenção, nunca o `checkout.updatedAt` genérico. Eles também atualizam monotonicamente o pagamento correlacionado para `REFUNDED` ou `DISPUTED` (`DISPUTED` prevalece em empate), mas preservam o status real da assinatura externa: reembolso ou disputa não prova que a recorrência foi cancelada. Enquanto não houver confirmação explícita de cancelamento, o sistema bloqueia um novo checkout para evitar duas assinaturas externas.

## Paywall derivado

O guard global roda depois do JWT e consulta a assinatura atual no banco em cada requisição. Somente `active` e `past_due` permitem operação. Os estados públicos são derivados dos fatos persistidos:

- `pending_payment`: primeiro pagamento ainda não comprovado;
- `active`: pagamento confirmado e `now < accessPaidThrough`;
- `past_due`: falha confirmada e `now <= graceUntil`;
- `suspended`: tolerância ou período pago expirou;
- `cancelled`: cancelamento ou revogação confirmada.

Campos ausentes, timestamps inválidos, evento desconhecido, ciclo diferente de `MONTHLY`, método diferente de `CARD` ou fatos contraditórios bloqueiam acesso. A passagem de `past_due` para `suspended` é uma comparação de relógio; nenhum cron altera status de autorização.

Para tenant bloqueado, a allowlist explícita cobre sessão, logout, consulta da assinatura, checkout, cancelamento e reconciliação. Rotas novas não entram automaticamente. Cancelamento exige owner e origem de navegador válida; ele também permanece disponível depois de refund/dispute para que o owner consiga encerrar uma recorrência externa ainda ativa. Ele é imediato e irreversível no provider; para retornar, o owner cria outro checkout e uma nova assinatura mensal depois da confirmação externa do cancelamento.

Se a chamada de cancelamento tiver resultado ambíguo, ela não é repetida automaticamente. A reconciliação consulta o checkout pelo `externalId` imutável e, quando a resposta autenticada do provider informa `CANCELLED` para a assinatura local que já possui `providerSubscriptionId`, registra `subscription.reconciled_cancelled`, encerra o estado ambíguo e libera somente então a criação de uma nova assinatura. Qualquer outro resultado permanece fail-closed e exige webhook ou suporte.

## Retenção

O purge é um CLI diário, idempotente e com uma única execução ativa:

```bash
npm run retention:purge
npm run retention:check
```

`retention:purge` remove em lote tenants `pending_payment` vencidos após sete dias e dados cancelados cujo `purgeAfter` atingiu doze meses. Antes de cada remoção, ele reavalia o paywall. Se um checkout pendente ou ambíguo ainda puder existir no provider, o comando o consulta por `externalId` fora da transação e só fecha localmente respostas `EXPIRED` ou `CANCELLED` com identidade integral e nenhuma evidência de ativação; `PENDING`, `PAID`, `REFUNDED`, ausência ou divergência permanecem fail-closed, e indisponibilidade/configuração inválida do provider faz a execução falhar para acionar o monitor. Depois, sob lock da família, a faxina recusa estados ativos, em tolerância, suspensos, ambíguos, com claim recente ou cobrança ainda possivelmente aberta. Uma revogação por refund/dispute só fica elegível depois de cancelamento externo confirmado. Toda a agregação do tenant é apagada na mesma transação, inclusive payloads brutos de `TelegramUpdate` atribuíveis aos chats exclusivos da família mesmo quando não geraram lançamento; updates ainda ligados a operação financeira são preservados pelo guard fail-closed até a exclusão da própria operação. Falha intermediária faz rollback.

A API publicada enumera `EXPIRED`, mas não documenta o prazo de expiração automática do checkout de assinatura, não aceita `expiresAt` na criação e o cancelamento publicado exige um `subs_...` ativo, não um `bill_...` pendente. Por isso, o SLA de apagar cadastro abandonado no sétimo dia é um bloqueador de rollout: não habilite novos owners até o sandbox provar que o checkout chega a `EXPIRED` dentro de `PENDING_PAYMENT_TTL_DAYS` ou o provider fornecer uma operação autenticada para invalidá-lo antes da exclusão. A configuração recusa `OWNER_SIGNUP_ENABLED=true` enquanto essa prova não for declarada explicitamente.

`retention:check` retorna código diferente de zero quando não existe execução concluída com sucesso nas últimas `RETENTION_PURGE_MAX_AGE_HOURS` (48 por padrão). Agende o purge diariamente e o check no monitor da infraestrutura, por exemplo:

```cron
17 3 * * * cd /srv/financas/backend && npm run retention:purge
*/30 * * * * cd /srv/financas/backend && npm run retention:check
```

Os comandos devem receber o mesmo `.env` protegido da aplicação. Antes do primeiro rollout, valide backup e restauração. Para rollback da aplicação, desligue primeiro os flags de signup, entitlement e webhook; não reverta uma migração destrutiva nem recrie dados já purgados.

## Ordem obrigatória de liberação

1. Aplicar a migração e publicar com todos os flags desligados.
2. Cadastrar webhook Dev com segredo exclusivo e URL HTTPS; confirmar secret da query e HMAC do corpo bruto em evento real.
3. Provar `completed`, `renewed`, `payment_failed` e `cancelled`, incluindo duplicata, reenvio e ordem invertida.
4. Fixar por evidência do sandbox o timestamp autoritativo do ciclo mensal, fim de mês, ano bissexto e retry tardio. Confirmar também `providerStatus` durante falha.
5. Provar que um checkout `PENDING` não pode ser pago depois do TTL local: confirmar transição automática para `EXPIRED` dentro do prazo ou uma operação segura de invalidação, e só então marcar `ABACATEPAY_PENDING_EXPIRY_CONTRACT_CONFIRMED=true`.
6. Implementar e incluir a versão comprovada na allowlist de contratos do código, preencher `ABACATEPAY_ENTITLEMENT_CONTRACT_VERSION`, executar os testes contratuais e somente então habilitar entitlement.
7. Validar cancelamento imediato, refund/dispute e novo checkout depois de `subscription.cancelled`.
8. Agendar e monitorar retenção; por último, habilitar `OWNER_SIGNUP_ENABLED` gradualmente.

Sem as evidências dos passos 2 a 4, eventos positivos continuam em quarentena e o rollout de novos owners permanece bloqueado.

## Referências oficiais

- Segurança de webhooks: <https://docs.abacatepay.com/pages/webhooks/security>
- Criação de webhook: <https://docs.abacatepay.com/pages/webhooks/create>
- Eventos de assinatura: <https://docs.abacatepay.com/pages/webhooks/events/subscriptions>
- Listagem e estados da assinatura: <https://docs.abacatepay.com/pages/subscriptions/list>
- Criação do checkout de assinatura: <https://docs.abacatepay.com/pages/subscriptions/create>
- Cancelamento: <https://docs.abacatepay.com/pages/subscriptions/cancel>
