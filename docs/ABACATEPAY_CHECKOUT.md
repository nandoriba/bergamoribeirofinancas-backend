# Checkout mensal da AbacatePay

## Estado de rollout

O runtime está preparado para criar e reconciliar checkout de assinatura `MONTHLY` exclusivamente com `CARD`. A mesma base oficial `https://api.abacatepay.com/v2` é usada nos dois ambientes; a chave seleciona Dev ou produção. `ABACATEPAY_ENABLED` e `OWNER_SIGNUP_ENABLED` permanecem `false` por padrão.

Esta fatia não concede acesso. A URL de conclusão apenas leva o navegador à tela de confirmação; o tenant continua `pending_payment` até a próxima fatia processar um webhook autenticado. Não habilite cadastro público em produção antes de validar webhook, paywall e fronteira do ciclo mensal no sandbox.

## Fluxo seguro e idempotência

1. O backend valida no provider que o produto está `ACTIVE`, em BRL, sem trial, no ambiente correto e com ciclo `MONTHLY` e preço exato.
2. Uma assinatura local recebe `externalId` estável e um claim persistente antes de qualquer efeito externo.
3. O serviço consulta `/subscriptions/list?externalId=...` antes de criar.
4. Antes do `POST /subscriptions/create`, a permissão local de criar novamente é desligada.
5. Timeout, falha de rede, `409`, `429`, `5xx` ou resposta inválida após o `POST` deixam o resultado como `ambiguous`. A próxima tentativa somente reconcilia por `externalId`; ela nunca repete o `POST` às cegas.
6. O ID `bill_...` e a URL hospedada são persistidos separados do futuro ID `subs_...` da assinatura ativa.

Se um processo cair exatamente depois de bloquear uma nova criação e antes de obter uma resposta do provider, uma consulta sem resultado continua `ambiguous`. Sem garantia documentada de consistência da listagem, somente uma verificação operacional no painel/suporte da AbacatePay pode autorizar o reset; o sistema prefere bloquear o checkout a arriscar uma cobrança duplicada.

A AbacatePay não documenta uma chave de idempotência para essa criação. Por isso, o estado durável e a reconciliação são parte do contrato de segurança, não apenas uma otimização.

## Endpoints

- `GET /payments/subscription`: membro autenticado do próprio tenant; retorna apenas estado público, plano, prazo e ações possíveis, sem IDs do provider ou do tenant. A ação de checkout só aparece para o owner elegível.
- `POST /payments/checkout`: owner verificado com pagamento pendente; exige origem de navegador permitida, aplica throttle e aceita DTO vazio. Produto, preço, método, metadados e URLs são montados pelo servidor.

O frontend aceita navegação somente para `https://app.abacatepay.com/pay/bill_...`, sem porta, credenciais, query, fragmento ou path adicional.

## Fronteira com a próxima fatia

O adapter já possui a operação de cancelamento para `subs_...`, mas esta fatia não publica um endpoint de cancelamento. A criação devolve primeiro `bill_...`; o identificador final da assinatura e os fatos que bloqueiam acesso chegam pelo webhook. Expor cancelamento antes de persistir esses efeitos atomicamente permitiria confirmar uma operação irreversível no provider sem bloquear o tenant local. Cancelamento, novo checkout pós-cancelamento, reconciliação da assinatura ativa e qualquer atualização de método entram junto com webhook e `SubscriptionAccessPolicy` na Fatia 8.

A API v2 consultada não documenta nesta integração um fluxo seguro de atualização de cartão que possamos prometer no MVP. Ele permanece indisponível até existir suporte contratual e teste no sandbox.

## Configuração

Com `ABACATEPAY_ENABLED=true`, informe:

- desenvolvimento/teste: `ABACATEPAY_DEV_API_KEY` e `ABACATEPAY_DEV_MONTHLY_PRODUCT_ID`;
- produção: `ABACATEPAY_PROD_API_KEY` e `ABACATEPAY_PROD_MONTHLY_PRODUCT_ID`;
- ambos: `ABACATEPAY_MONTHLY_AMOUNT_CENTS`, `ABACATEPAY_PLAN_NAME`, timeout, política de retry da cobrança e lease do claim descritos em `.env.example`.

Credenciais de produção são rejeitadas fora de produção e credenciais Dev são rejeitadas em produção. A aplicação valida a base HTTPS oficial, os prefixos de produto `prod_`/`prod-` documentados pela API v2 e a configuração completa ao iniciar.

## Responsabilidades humanas antes do rollout

- criar chaves distintas de Dev e produção no cofre;
- criar e conferir o produto mensal sem trial em cada ambiente;
- executar checkout real em Dev e comprovar os eventos de conclusão e renovação;
- cadastrar o webhook de produção com secret exclusivo;
- determinar no sandbox o timestamp autoritativo e a fronteira exata do ciclo mensal, inclusive fim de mês e retry atrasado.

Sem essa última evidência, a próxima fatia deve continuar falhando fechada e o rollout permanece bloqueado.

## Referências oficiais

- Criação: <https://docs.abacatepay.com/pages/subscriptions/create>
- Consulta e reconciliação: <https://docs.abacatepay.com/pages/subscriptions/list>
- Cancelamento: <https://docs.abacatepay.com/pages/subscriptions/cancel>
- Autenticação e ambientes: <https://docs.abacatepay.com/pages/authentication>
