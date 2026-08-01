# Convites e gestão de membros

## Invariantes

- O tenant vem exclusivamente do convite persistido; payloads públicos não aceitam `familyId`, `userId`, papel ou privilégios.
- Criar, listar e revogar convites, aprovar ou rejeitar solicitações e inativar membros são operações exclusivas do owner e continuam sujeitas ao paywall global.
- O aceite público revalida, dentro de transação serializável, o convite, sua expiração, o e-mail restrito e o entitlement atual da família.
- Cada convite produz no máximo uma solicitação. A restrição única em `MemberApproval.inviteId`, o lock da família/convite e o CAS de `active` para `used` protegem corridas entre senha, Google e revogação.
- O convidado nasce com `User.isActive = false` e `MemberProfile.status = pending`. Nenhum aceite cria cookie de sessão.
- No aceite local, `User.email` permanece em placeholder interno `@invite.invalid` até o OTP. O endereço solicitado fica em `MemberApproval`, token e outbox; por isso pendências de famílias diferentes não reservam globalmente o e-mail. A promoção é atômica e somente um concorrente pode vencer.
- No fluxo local, o owner só pode aprovar depois da confirmação do código de seis dígitos. No fluxo Google, o e-mail já chega verificado pelo ID token validado.
- Coincidência de e-mail ou de identidade Google nunca move nem vincula uma conta existente a outro tenant.
- O owner da família não pode ser inativado. A inativação de membro incrementa `authVersion`, revoga vínculos/códigos do Telegram e preserva o histórico financeiro.

## Fluxos públicos

1. O navegador abre `/convite/:token`. O proxy não registra esse prefixo e a aplicação usa `Referrer-Policy: no-referrer`.
2. O frontend resolve o convite por `POST /member-invites/resolve`, enviando o token no corpo. A resposta não devolve o token nem o e-mail completo.
3. Aceite local: `POST /member-invites/register` cria usuário/perfil pendentes, solicitação e desafio de verificação na mesma transação. O reenvio usa `POST /member-invites/email-verification/resend` e informa `sent` para distinguir um novo e-mail do mesmo desafio devolvido durante o cooldown. A confirmação usa `POST /member-invites/email-verification/confirm` e retorna `pending_approval`, sem sessão. Confirmar e reenviar revalidam o entitlement dentro da transação.
4. Se uma resposta se perder, resolver novamente um convite `used` devolve `continuation` somente quando approval, família, perfil, usuário e entitlement seguem coerentes. `POST /member-invites/email-verification/status` com `challengeId` retorna `verify_email` com metadados seguros do desafio mais recente ou `pending_approval` depois do OTP. Estados aprovados, rejeitados ou estranhos recebem erro genérico.
5. O e-mail usa exclusivamente `/convite/verificacao?challenge=<UUID>`. A continuation cifrada tem allowlist exata, o template injeta o próprio ID persistido e nenhum bearer do convite aparece no payload ou link.
6. Aceite Google: `POST /auth/google/start` recebe somente `intent = accept_invite`, `inviteToken` e `memberName`. O backend persiste apenas o ID interno do convite e o nome normalizado na tentativa OAuth. O callback revalida tudo e redireciona para `/convite/resultado`, sem sessão.
7. Depois da aprovação, o membro entra normalmente por senha ou pela identidade Google vinculada e recebe a sessão própria do sistema.

A emissão aplica quota persistente por destinatário (`ACTION_TOKEN_RECIPIENT_HOURLY_LIMIT` e `ACTION_TOKEN_RECIPIENT_DAILY_LIMIT`) com advisory lock, cruzando userIds e tenants sem criar unicidade pendente de longa duração. A rejeição volta o usuário ao placeholder, limpa verificação/identidade Google e libera novo aceite.

## Operações do owner

- `POST /member-invites` cria um convite e devolve o link somente nessa resposta.
- `GET /member-invites` lista resumos sem token.
- `POST /member-invites/:id/revoke` encerra um convite ainda não consumido.
- `GET /member-approvals` lista solicitações e informa se o e-mail já foi verificado.
- `POST /member-approvals/:id/approve` ativa usuário e perfil somente após a verificação.
- `POST /member-approvals/:id/reject` encerra a solicitação pendente.
- `GET /members` lista owner e membros do próprio tenant.
- `POST /members/:id/deactivate` inativa apenas um membro não-owner do mesmo tenant.

Todos os IDs das rotas protegidas são revalidados contra `familyId` no banco; um admin de plataforma que seja apenas member não recebe poderes de owner.
