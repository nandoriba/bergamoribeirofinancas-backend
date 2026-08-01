import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import type { TenantContext } from '../shared/tenant-context';
import { PrismaService } from './prisma.service';

export interface TenantProfileSelection {
  family?: boolean;
  profileId?: string;
}

@Injectable()
export class TenantScopeService {
  constructor(private readonly prisma: PrismaService) {}

  /** Escopo para registros financeiros gravados pelo perfil autenticado. */
  byAuthor(context: TenantContext) {
    return { memberProfileId: context.authorProfileId } as const;
  }

  /** Escopo para registros financeiros visíveis à família autenticada. */
  byFamilyProfiles(context: TenantContext) {
    return { memberProfile: { familyId: context.familyId } } as const;
  }

  /** Escopo para modelos que possuem familyId diretamente. */
  byFamily(context: TenantContext) {
    return { familyId: context.familyId } as const;
  }

  /** Exclui relações financeiras inconsistentes antes que includes revelem outro tenant. */
  consistentTransactionRelations(context: TenantContext): Prisma.TransactionWhereInput {
    const familyId = context.familyId;
    return {
      AND: [
        { OR: [{ accountId: null }, { account: { memberProfile: { familyId } } }] },
        { OR: [{ categoryId: null }, { category: { familyId } }] },
        {
          OR: [
            { invoiceId: null },
            { invoice: { memberProfile: { familyId }, account: { memberProfile: { familyId } } } },
          ],
        },
        { OR: [{ installmentPlanId: null }, { installmentPlan: { memberProfile: { familyId } } }] },
        { OR: [{ recurringTemplateId: null }, { recurringTemplate: { memberProfile: { familyId } } }] },
      ],
    };
  }

  consistentInvoiceRelations(context: TenantContext): Prisma.InvoiceWhereInput {
    return { account: { memberProfile: { familyId: context.familyId } } };
  }

  consistentRecurringRelations(
    context: TenantContext,
    allowedAccountIds: string[],
  ): Prisma.RecurringTemplateWhereInput {
    const familyId = context.familyId;
    return {
      AND: [
        { OR: [{ accountId: null }, { accountId: { in: allowedAccountIds } }] },
        { OR: [{ categoryId: null }, { category: { familyId } }] },
      ],
    };
  }

  async resolveProfileIds(context: TenantContext, selection: TenantProfileSelection = {}): Promise<string[]> {
    if (selection.profileId) {
      const profile = await this.prisma.memberProfile.findFirst({
        where: {
          id: selection.profileId,
          familyId: context.familyId,
        },
        select: { id: true },
      });

      if (!profile) throw new BadRequestException('Perfil inválido');
      return [profile.id];
    }

    if (!selection.family) return [context.authorProfileId];

    const profiles = await this.prisma.memberProfile.findMany({
      where: {
        familyId: context.familyId,
      },
      select: { id: true },
      orderBy: { displayName: 'asc' },
    });

    return profiles.map((profile) => profile.id);
  }
}
