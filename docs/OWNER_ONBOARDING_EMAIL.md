# Owner onboarding, e-mail e recuperação

## Estado de rollout

`OWNER_SIGNUP_ENABLED` deve permanecer `false` até o webhook autoritativo e o contrato mensal do sandbox estarem validados. A implementação atual já é fail-closed: famílias criadas pelo onboarding recebem `pendingPaymentExpiresAt`, a sessão deriva `requiredAction=payment` e o guard global nega módulos financeiros. Além de `/auth/me` e `/auth/logout`, somente consulta da assinatura, criação de checkout e reconciliação possuem allowlist explícita para essa sessão. Eventos positivos permanecem em quarentena até a evidência contratual descrita em [ABACATEPAY_WEBHOOK_PAYWALL_RETENTION.md](ABACATEPAY_WEBHOOK_PAYWALL_RETENTION.md).

O fluxo por e-mail também exige `EMAIL_PROVIDER=resend`, canal de suporte e segredos independentes. A aplicação falha na inicialização se a combinação estiver incompleta.

Durante esta fatia, criar ou aceitar novos convites retorna `503`. Isso evita
persistir membros que não conseguiriam cumprir a nova verificação obrigatória. A
migração considera todos os usuários já persistidos como legados verificados —
inclusive os inativos aguardando aprovação — para preservar convites anteriores.
A Fatia 9 reabre o fluxo somente com verificação por código no cadastro local e
identidade verificada no aceite Google.

## Transações e estados

O cadastro local executa, sob isolamento `Serializable`, um único commit com:

1. `Family` sem entitlement e com prazo de pagamento definido pelo servidor;
2. `User` com placeholder interno `@signup.invalid`, `emailVerifiedAt=null`, role de plataforma `user` e perfil ativo; o e-mail solicitado fica somente no token/outbox até o OTP;
3. owner da própria família;
4. `LegalAcceptance` append-only com versão vigente e horário do servidor;
5. `UserActionToken` de verificação;
6. `EmailOutbox` com payload cifrado.

O trigger diferido do banco valida o owner no commit. O provider de e-mail nunca é chamado dentro da transação. Em caso de conflito ou falha, não ficam família, usuário, aceite, token ou outbox órfãos.

O cadastro Google armazena nomes e aceite na tentativa OAuth antes do redirect. O callback usa somente essa tentativa consumida e a identidade OIDC verificada para criar família, owner, perfil, identidade e aceite na mesma transação. Não há auto-link por coincidência de e-mail.

## Códigos, links e outbox

- O código de verificação tem seis dígitos, preserva zeros à esquerda e é gerado com CSPRNG.
- O banco guarda apenas HMAC-SHA-256 com domínio, finalidade, challenge, usuário e e-mail.
- O reset usa segredo aleatório de 256 bits, uso único e expiração curta.
- O payload necessário ao envio fica em AES-256-GCM com chave separada e AAD vinculada ao ID da outbox.
- O dispatcher revalida o token antes de enviar, usa `Idempotency-Key`, recupera locks abandonados e limpa o ciphertext ao enviar ou descartar.
- Reenvios possuem cooldown, limites persistentes por hora/dia, revogam desafios anteriores e serializam concorrência por usuário.
- A emissão inicial e os reenvios que realmente criariam outro token também usam quota persistente por destinatário, cruzando usuários e tenants. Um advisory lock transacional impede que concorrência ultrapasse o limite; cooldown que apenas reapresenta metadados não consome quota.
- Confirmação, consumo e mutação do usuário usam lock de linha. Tentativas inválidas incrementam atomicamente até o lockout.
- A confirmação promove o e-mail real antes de consumir o desafio, no mesmo commit. Cadastros pendentes iguais não reservam o endereço: somente uma promoção vence a unicidade, e o desafio perdedor permanece não consumido. Owners legados com e-mail real e ainda não verificado continuam aceitos somente quando perfil e ownership da família conferem.
- A solicitação pública de reset aguarda somente a inserção genérica de `PasswordResetRequest`, antes de qualquer busca de conta. O e-mail canônico fica cifrado em AES-256-GCM com domínio e AAD próprios, separados da outbox.
- O worker reivindica a solicitação com lease persistente, recupera locks abandonados e limpa o ciphertext ao concluir ou descartar. Para contas elegíveis, token, outbox e conclusão da solicitação são gravados no mesmo commit; uma falha antes do commit permanece recuperável sem perder a solicitação.
- Solicitações desconhecidas, inelegíveis ou limitadas por cooldown terminam no mesmo estado público, sem envio. Com o provider desabilitado, ficam pendentes até expirar e então são descartadas com limpeza do ciphertext.

O link de reset é trocado por cookie transitório HttpOnly em `/auth/password-reset/continue`; o frontend recebe uma URL limpa. O Nginx desativa access/error logs na rota exata que recebe o segredo. A troca de senha consome o token e incrementa `authVersion` no mesmo commit, invalidando todos os JWTs anteriores. Uma conta Google-only pode criar sua primeira senha sem perder a identidade Google.

O e-mail de owner continua em `/verificar-email?challenge=<UUID>`. Convites usam somente a continuation allowlisted `/convite/verificacao?challenge=<UUID>`; o payload cifrado nunca controla origin, query ou bearer do convite.

## Configuração

Além das variáveis de autenticação existentes:

- `OWNER_SIGNUP_ENABLED=false`
- `LEGAL_BUNDLE_VERSION`
- `PENDING_PAYMENT_TTL_DAYS`
- `EMAIL_PROVIDER=disabled|resend`
- `ACTION_TOKEN_SECRET`
- `EMAIL_OUTBOX_SECRET`
- `EMAIL_OUTBOX_KEY_VERSION`
- `ACTION_TOKEN_RECIPIENT_HOURLY_LIMIT=3`
- `ACTION_TOKEN_RECIPIENT_DAILY_LIMIT=10`
- `RESEND_API_KEY`
- `EMAIL_FROM`
- `SUPPORT_EMAIL`
- `PUBLIC_API_ORIGIN`
- TTLs, tentativas, limites e cooldown descritos em `.env.example`

Os segredos de token, outbox, OAuth e JWT devem ser diferentes. Em produção, `WEB_ORIGIN` e `PUBLIC_API_ORIGIN` precisam ser origins HTTPS públicas e os cookies devem usar `Secure`.

## Checklist antes de habilitar

- Validar o checkout AbacatePay e publicar o webhook autoritativo, o paywall derivado e o contrato mensal do sandbox.
- Revisar Termos e Política de Privacidade com responsável jurídico.
- Preencher controlador, endereço, encarregado/canal de privacidade e operadores reais.
- Confirmar domínio remetente no Resend e testar entrega, bounce e rate limits.
- Gerar segredos independentes no cofre do ambiente.
- Validar backup/restauração, agendar `retention:purge` diariamente e alertar via `retention:check`.
- Executar unitários, integração PostgreSQL, E2E e smoke test no ambiente integrado.

## Referências técnicas e legais

- Resend, envio e idempotência: <https://resend.com/docs/api-reference/emails/send-email>
- OWASP, recuperação de senha: <https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html>
- Lei Geral de Proteção de Dados: <https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709compilado.htm>
- ANPD, direitos dos titulares: <https://www.gov.br/anpd/pt-br/assuntos/titular-de-dados-1/direito-dos-titulares>

As páginas legais entregues nesta fatia são minutas operacionais e não substituem revisão jurídica.
