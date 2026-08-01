import { HttpStatus, ValidationPipe } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';

import {
  ALLOW_PENDING_PAYMENT_ACCESS_KEY,
} from '../../shared/allow-pending-payment-access.decorator';
import { TenantOwnerGuard } from '../../shared/tenant-owner.guard';
import { BrowserOriginGuard } from '../auth/browser-origin.guard';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CreateCheckoutDto } from './dto/create-checkout.dto';
import { PaymentsController } from './payments.controller';
import type { PaymentsService } from './payments.service';

const THROTTLER_LIMIT_DEFAULT = 'THROTTLER:LIMITdefault';
const THROTTLER_TTL_DEFAULT = 'THROTTLER:TTLdefault';

describe('PaymentsController', () => {
  it('delega consulta e criação sem aceitar identidade de cobrança no DTO', async () => {
    const payments = {
      getSubscriptionSummary: vi.fn().mockResolvedValue({ effectiveStatus: 'pending_payment' }),
      createCheckout: vi.fn().mockResolvedValue({ checkoutUrl: 'https://app.abacatepay.com/pay/bill_1' }),
    } as unknown as PaymentsService;
    const controller = new PaymentsController(payments);
    const user = { id: 'owner-1', familyId: 'family-1' } as AuthenticatedUser;

    await expect(controller.getSubscription(user)).resolves.toEqual({
      effectiveStatus: 'pending_payment',
    });
    await expect(controller.createCheckout(user, new CreateCheckoutDto())).resolves.toEqual({
      checkoutUrl: 'https://app.abacatepay.com/pay/bill_1',
    });
    expect(payments.getSubscriptionSummary).toHaveBeenCalledWith(user);
    expect(payments.createCheckout).toHaveBeenCalledWith(user);
  });

  it('permite as duas rotas durante pagamento pendente e restringe somente o POST ao owner', () => {
    const reflector = new Reflector();
    const getHandler = PaymentsController.prototype.getSubscription;
    const postHandler = PaymentsController.prototype.createCheckout;

    for (const handler of [getHandler, postHandler]) {
      expect(
        reflector.getAllAndOverride<boolean>(ALLOW_PENDING_PAYMENT_ACCESS_KEY, [
          handler,
          PaymentsController,
        ]),
      ).toBe(true);
    }
    expect(guardsFor(getHandler)).not.toContain(TenantOwnerGuard);
    expect(guardsFor(postHandler)).toContain(TenantOwnerGuard);
  });

  it('protege somente a mutação com Origin e aplica 3 tentativas por minuto', () => {
    const getHandler = PaymentsController.prototype.getSubscription;
    const postHandler = PaymentsController.prototype.createCheckout;

    expect(guardsFor(getHandler)).not.toContain(BrowserOriginGuard);
    expect(guardsFor(postHandler)).toEqual(
      expect.arrayContaining([BrowserOriginGuard, TenantOwnerGuard]),
    );
    expect(Reflect.getMetadata(THROTTLER_LIMIT_DEFAULT, postHandler)).toBe(3);
    expect(Reflect.getMetadata(THROTTLER_TTL_DEFAULT, postHandler)).toBe(60_000);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, postHandler)).toBe(HttpStatus.OK);
  });

  it('rejeita qualquer campo enviado no corpo sob a ValidationPipe global', async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });

    await expect(
      pipe.transform(
        {
          productId: 'produto-controlado-pelo-cliente',
          amountCents: 1,
          returnUrl: 'https://attacker.example',
        },
        { type: 'body', metatype: CreateCheckoutDto },
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      pipe.transform({}, { type: 'body', metatype: CreateCheckoutDto }),
    ).resolves.toBeInstanceOf(CreateCheckoutDto);
  });
});

function guardsFor(handler: (...args: never[]) => unknown) {
  return (Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[] | undefined) ?? [];
}
