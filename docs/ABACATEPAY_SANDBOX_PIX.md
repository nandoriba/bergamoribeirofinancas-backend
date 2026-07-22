# Validação do Pix Automático no sandbox da AbacatePay

**Data da pesquisa:** 22/07/2026

**Decisão vigente:** `CARD_ONLY`

Este documento é o runbook de decisão para habilitar, ou não, Pix no checkout da assinatura mensal. Ele não autoriza Pix por expectativa, por exemplo da documentação ou por sucesso de uma cobrança avulsa. A habilitação é **fail-closed**: até que todos os critérios deste documento sejam comprovados no Dev mode, o produto deve enviar somente `methods: ["CARD"]`.

## O que a documentação oficial afirma — e por que ainda é inconclusivo

As páginas oficiais consultadas em 22/07/2026 se contradizem:

| Fonte oficial                                                                             | Afirmação observada                                                                                                                                                                                                                                                               | Consequência para este projeto                                                                                                                               |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`POST /v2/subscriptions/create`](https://docs.abacatepay.com/pages/subscriptions/create) | A descrição de `methods` diz que assinaturas suportam apenas `CARD` e que o padrão é `["CARD"]`; na mesma definição, o enum oferece `PIX` e `CARD`.                                                                                                                               | O schema publicado não basta para concluir que `PIX` funciona em assinatura.                                                                                 |
| [Eventos de assinatura](https://docs.abacatepay.com/pages/webhooks/events/subscriptions)  | A página se apresenta como eventos de assinaturas “PIX e Cartão” e mostra exemplos PIX para `subscription.completed`, `subscription.renewed` e `subscription.cancelled`.                                                                                                          | Os payloads sugerem suporte, mas exemplos documentais não provam que a loja deste projeto pode criar e renovar a assinatura.                                 |
| [Changelog de 15/05/2026](https://docs.abacatepay.com/pages/changelog#15-de-mai-2026)     | Informa que Pix Automático só está disponível para lojas com o recurso habilitado no dashboard e orienta contatar o suporte quando não houver acesso. O exemplo, porém, usa `POST /v2/checkouts/create`, enquanto a referência de assinatura usa `POST /v2/subscriptions/create`. | Há um gate por loja e um conflito de endpoint. É obrigatório confirmar o fluxo real no Dev mode e obter do suporte o procedimento oficial aplicável à conta. |

Portanto, documentação, enum ou exemplo de payload são apenas indícios. Nenhum deles muda a decisão `CARD_ONLY`.

## Dev mode é definido pela chave

A AbacatePay usa a mesma base `https://api.abacatepay.com/v2` em desenvolvimento e produção. Segundo a [documentação de autenticação](https://docs.abacatepay.com/pages/authentication), **o ambiente é determinado pela chave usada na requisição**:

- chave criada em Dev mode produz transações simuladas;
- chave criada em Produção produz transações reais.

Não existe uma URL de sandbox alternativa nem um parâmetro local capaz de transformar uma chave de produção em chave Dev. O probe deve usar exclusivamente uma chave Dev separada e deve rejeitar qualquer resposta ou evento cujo `devMode` não seja exatamente `true`.

## O que não valida uma assinatura recorrente

O endpoint [`POST /v2/transparents/simulate-payment`](https://docs.abacatepay.com/pages/transparents/simulate-payment) simula o pagamento de um QR Code Pix criado pelo **Checkout Transparente**. Ele pode comprovar que uma cobrança transparente passa para `PAID`, mas não comprova:

- que `POST /v2/subscriptions/create` aceita Pix para esta loja;
- que o primeiro pagamento gera `subscription.completed`;
- que o provider gera `subscription.renewed` posteriormente;
- que a renovação acontece sem novo QR Code, novo checkout ou nova ação do pagador.

Pelo mesmo motivo, [`abacatepay payments simulate`](https://docs.abacatepay.com/pages/cli/payments), `abacatepay trigger`, `abacatepay events sample`, `abacatepay listen --mock` e reenvios locais descritos na [CLI de webhooks](https://docs.abacatepay.com/pages/cli/webhooks) **não validam a assinatura recorrente**. Eles são úteis para desenvolver parsing e transporte, mas fixtures, mocks, cobranças Pix transparentes e eventos reenviados não substituem eventos de assinatura originados pelo provider no ciclo real do Dev mode.

Neste parágrafo, “assinatura” significa a cobrança recorrente (`subscription`). A autenticação criptográfica do webhook é outro requisito e continua obrigatória: secret na query string e HMAC-SHA256 sobre o corpo bruto, conforme a [página oficial de segurança](https://docs.abacatepay.com/pages/webhooks/security).

## Pré-requisitos que dependem de uma pessoa

Antes de executar a validação, o responsável pela conta deve:

1. Criar ou confirmar uma conta AbacatePay em Dev mode.
2. Criar uma chave **Dev**, separada da produção e com o menor conjunto de permissões necessário para consultar o produto e criar/consultar checkouts de assinatura. A chave não deve ser enviada por chat nem gravada no repositório.
3. Criar no Dev mode um único produto de teste com ciclo exatamente `MONTHLY`, valor em centavos e **sem trial**: omitir `trialDays`. A [referência de criação de produto](https://docs.abacatepay.com/pages/products/create) reserva valores de 1 a 90 para produtos com trial; um trial posterga a primeira cobrança integral e, por isso, invalida esta prova.
4. Solicitar/habilitar **Pix Automático para assinaturas** no dashboard. Se a opção não estiver disponível, contatar o suporte indicado no [changelog oficial](https://docs.abacatepay.com/pages/changelog#pix-automatico-para-assinaturas); a [FAQ oficial](https://docs.abacatepay.com/pages/faq/index) publica o contato `ajuda@abacatepay.com`.
5. Cadastrar um webhook de Dev mode para uma URL pública HTTPS, com secret exclusivo, contemplando pelo menos `subscription.completed` e `subscription.renewed`. A referência oficial exige HTTPS e secret em [`POST /v2/webhooks/create`](https://docs.abacatepay.com/pages/webhooks/create).
6. Obter do suporte da AbacatePay um procedimento oficial e reproduzível, válido para a loja Dev, para:
   - concluir a primeira ativação Pix Automático;
   - provocar ou aguardar a primeira renovação;
   - demonstrar que a renovação não exige novo QR Code, novo checkout, nova leitura ou confirmação manual do pagador.
7. Registrar, em local interno restrito, o número/data do atendimento e o procedimento informado. Não aceitar como substituto a orientação de usar `/transparents/simulate-payment` ou mocks da CLI, pois esses fluxos não exercitam uma assinatura.

Se o suporte não indicar como produzir os dois eventos de assinatura no Dev mode, a validação termina como bloqueada e a decisão permanece `CARD_ONLY`.

## Execução do probe

O probe faz acesso de rede e cria até dois checkouts no Dev mode (controle `CARD` e candidato `PIX`); por isso, não integra `npm test`. O runner carrega o `.env` local do backend quando ele existe; esse arquivo é ignorado pelo Git, mas ainda deve ser protegido como segredo. Também é possível injetar as credenciais somente no processo:

```powershell
Set-Location "bergamoribeirofinancas-backend"

# Defina os valores reais por um mecanismo local seguro; não os cole em logs,
# tickets, commits ou histórico de shell compartilhado.
$env:ABACATEPAY_DEV_API_KEY = "<chave-dev>"
$env:ABACATEPAY_DEV_MONTHLY_PRODUCT_ID = "<prod_...>"

npm run abacatepay:sandbox:probe
```

O comando esperado é sempre:

```text
npm run abacatepay:sandbox:probe
```

O probe deve usar a URL oficial fixa, conferir a configuração antes da primeira chamada e produzir somente saída sanitizada. Ele não deve imprimir a chave, headers, URLs completas de checkout/webhook, query strings, corpo bruto ou payload integral da resposta.

Os códigos de saída são estáveis:

| Código | Significado                                                                                                                                                                   | Decisão de método |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `1`    | O contrato observado é inválido ou contraditório, por exemplo produto fora do Dev mode, ciclo/trial incorreto ou resposta 2xx inesperada.                                     | `CARD_ONLY`       |
| `2`    | A prova ficou bloqueada ou inconclusiva: configuração ausente, autenticação/permissão, rede/provider, feature indisponível, rejeição genérica ou requisição `PIX` aceita sem método/renovação comprovados. | `CARD_ONLY`       |

Sem as duas variáveis, o comando encerra com código `2`, lista somente os nomes ausentes e faz zero chamadas HTTP. Em `NODE_ENV=production`, ele também recusa a execução antes da rede.

Esta versão não possui caminho válido para código `0`: a AbacatePay não documenta um código de erro estável e específico que diferencie “Pix Automático indisponível” de um payload inválido, e a resposta de criação não ecoa o método efetivamente oferecido. Assim, `400`, `409`, `422` ou uma resposta 2xx ao pedido com `methods: ["PIX"]` permanecem inconclusivos. O gate só poderá ganhar um resultado positivo quando incorporar evidência autenticada e correlacionada de `subscription.completed` e `subscription.renewed`.

Uma execução automática pode comprovar a existência do produto `MONTHLY` sem trial e que a API aceitou uma requisição contendo `methods: ["PIX"]`. Como a resposta documentada não devolve o método, ela não comprova que o checkout hospedado realmente ofereceu Pix Automático. Os webhooks reais de `completed` e `renewed` e a ausência de nova ação do pagador ainda precisam ser observados pelo procedimento oficial do suporte.

Ao terminar o trabalho local, remova as variáveis do processo:

```powershell
Remove-Item Env:ABACATEPAY_DEV_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:ABACATEPAY_DEV_MONTHLY_PRODUCT_ID -ErrorAction SilentlyContinue
```

## Matriz de aceitação fail-closed

Pix somente poderá ser acrescentado aos métodos do MVP quando **todas** as linhas estiverem aprovadas com evidência do mesmo fluxo Dev:

| Critério obrigatório     | Evidência mínima aceitável                                                                                                                                                             | Reprovação/bloqueio                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Ambiente                 | Produto, checkout e ambos os eventos pertencem à conta/chave Dev; respostas e webhooks trazem `devMode: true`.                                                                         | `devMode` ausente, `false`, desconhecido ou divergente.                                                  |
| Produto                  | É o produto esperado, tem ciclo exatamente `MONTHLY` e não possui trial.                                                                                                               | Outro produto, outro ciclo, trial positivo ou campo impossível de confirmar.                             |
| Criação do checkout      | O endpoint oficial de assinatura aceito para a loja cria checkout com `methods: ["PIX"]`, vinculado ao produto esperado. A página hospedada oferece o consentimento de Pix Automático. | Enum aceito apenas pelo schema, erro/feature indisponível, checkout comum/avulso ou oferta de Pix comum. |
| Primeira ativação        | Webhook originado pela AbacatePay, autenticado por secret e HMAC sobre o corpo bruto, com `event: "subscription.completed"`.                                                           | Fixture, CLI, replay local, polling, retorno do navegador ou evento não autenticado.                     |
| Renovação                | Segundo webhook originado pela AbacatePay para a **mesma assinatura**, com `event: "subscription.renewed"` e pagamento distinto.                                                       | Ausência do evento, assinatura diferente ou evento fabricado/reenviado como prova.                       |
| Sem nova ação do pagador | Depois do consentimento inicial, a renovação ocorre pelo procedimento oficial sem novo checkout, QR Code, leitura ou confirmação do pagador.                                           | Qualquer nova ação manual para pagar a parcela renovada.                                                 |
| Versão dos eventos       | Nos dois webhooks, `apiVersion` é exatamente `2` e `devMode` é exatamente `true`.                                                                                                      | Campo ausente, tipo inesperado, outra versão ou ambiente contraditório.                                  |
| Pagamentos               | Em `completed` e `renewed`, `data.payment.status` é exatamente `PAID`; IDs de evento e pagamento demonstram ocorrências distintas.                                                     | `PENDING`, `FAILED`, campo ausente ou reaproveitamento de uma única ocorrência.                          |
| Método                   | Nos dois eventos, `data.subscription.method` é `PIX`; `data.payment.methods` e `data.checkout.methods`, quando presentes, são coerentes com Pix.                                       | `CARD`, método ausente ou fatos contraditórios.                                                          |
| Frequência               | Nos dois eventos, `data.subscription.frequency` é `MONTHLY`; o checkout é de assinatura e referencia o produto mensal esperado.                                                        | Frequência ausente, diferente de `MONTHLY`, checkout avulso ou produto divergente.                       |

Além disso:

- `completed` sem `renewed` é insuficiente;
- checkout Pix aceito sem os dois eventos é insuficiente;
- os dois eventos sem prova de renovação automática são insuficientes;
- qualquer campo obrigatório ausente, desconhecido ou contraditório reprova a validação;
- o retorno do navegador nunca é evidência de pagamento ou entitlement.

### Resultado permitido

- **Todos os critérios aprovados:** a equipe pode propor `CARD_PIX`, ainda sujeita a revisão do diff e dos testes da integração.
- **Qualquer critério pendente ou reprovado:** resultado obrigatório `CARD_ONLY`.

Na data desta pesquisa não há evidência sandbox completa anexada a este repositório. Logo, a decisão registrada é:

```text
CARD_ONLY
```

## Evidência a registrar

Conservar, em armazenamento interno com acesso restrito e retenção definida:

- data/hora da execução e versão do probe;
- identificadores do produto, checkout, assinatura, eventos e pagamentos, de forma redigida ou correlacionada por hash quando possível;
- resultado das comparações `apiVersion`, `devMode`, status, método e frequência;
- hash do corpo bruto recebido e o booleano da validação HMAC, não o corpo bruto em logs;
- ordem temporal de `subscription.completed` e `subscription.renewed`;
- número/data da orientação oficial do suporte usada para acionar a renovação;
- confirmação humana de que não houve nova ação do pagador.

Não promova payloads ou credenciais do sandbox a fixtures de produção.

## Segredos e dados que nunca podem ser logados

Não imprimir, persistir em logs, commitar ou anexar a tickets/CI:

- chave API Dev ou de produção e o header `Authorization`;
- secret do webhook, URL completa com `webhookSecret` ou qualquer query string que o contenha;
- valor do header `X-Webhook-Signature`, corpo bruto ou payload integral do webhook;
- dados completos de cartão, inclusive cartões de teste;
- `brCode`, imagem/base64 do QR Code Pix ou credenciais/artefatos de consentimento;
- CPF/CNPJ (`taxId`), nome, e-mail, telefone, endereço ou `payerInformation` completos;
- URL completa de checkout ou recibo;
- dump integral de requests, responses, objetos de erro, variáveis de ambiente ou configuração do processo.

Logs operacionais devem se limitar a campos não sensíveis e necessários: nome do teste, decisão `CARD_ONLY`/`CARD_PIX`, booleanos de validação, enums esperados, timestamps e identificadores redigidos. Em caso de erro, registrar código HTTP e categoria sanitizada, nunca o request/response completo.

## Referências oficiais consultadas

- [Criar Checkout de assinatura](https://docs.abacatepay.com/pages/subscriptions/create)
- [Eventos de assinatura](https://docs.abacatepay.com/pages/webhooks/events/subscriptions)
- [Changelog da API — 15/05/2026](https://docs.abacatepay.com/pages/changelog#15-de-mai-2026)
- [Chaves de API — Dev mode x Produção](https://docs.abacatepay.com/pages/authentication)
- [Dev mode](https://docs.abacatepay.com/pages/devmode)
- [Criar produto](https://docs.abacatepay.com/pages/products/create)
- [Simular pagamento de Checkout Transparente](https://docs.abacatepay.com/pages/transparents/simulate-payment)
- [CLI — pagamentos](https://docs.abacatepay.com/pages/cli/payments)
- [CLI — webhooks e eventos](https://docs.abacatepay.com/pages/cli/webhooks)
- [Criar webhook](https://docs.abacatepay.com/pages/webhooks/create)
- [Verificação e segurança de webhooks](https://docs.abacatepay.com/pages/webhooks/security)
- [Perguntas frequentes e contato de suporte](https://docs.abacatepay.com/pages/faq/index)
