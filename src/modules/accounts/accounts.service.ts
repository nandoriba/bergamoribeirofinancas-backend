import { Injectable, NotFoundException } from '@nestjs/common';
import type { AccountType } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { TenantScopeService } from '../../prisma/tenant-scope.service';
import type { TenantContext } from '../../shared/tenant-context';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';

@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantScope: TenantScopeService = new TenantScopeService(prisma),
  ) {}

  list(context: TenantContext) {
    return this.prisma.account.findMany({
      where: this.tenantScope.byFamilyProfiles(context),
      include: { memberProfile: { select: { id: true, displayName: true } } },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    });
  }

  create(context: TenantContext, dto: CreateAccountDto) {
    return this.prisma.account.create({
      data: {
        name: dto.name.trim(),
        type: dto.type,
        institution: normalizeOptionalString(dto.institution),
        ...this.normalizeCardFields(dto, dto.type),
        initialBalanceCents: dto.initialBalanceCents ?? 0,
        memberProfileId: context.authorProfileId,
      },
    });
  }

  async update(context: TenantContext, id: string, dto: UpdateAccountDto) {
    const account = await this.ensureOwnAccount(context, id);
    const nextType = dto.type ?? account.type;
    return this.prisma.account.update({
      where: { id, ...this.tenantScope.byAuthor(context) },
      data: {
        name: dto.name?.trim(),
        type: dto.type,
        institution: normalizeOptionalString(dto.institution),
        ...this.normalizeCardFields(dto, nextType),
        initialBalanceCents: dto.initialBalanceCents,
      },
    });
  }

  async remove(context: TenantContext, id: string) {
    await this.ensureOwnAccount(context, id);
    return this.prisma.account.delete({ where: { id, ...this.tenantScope.byAuthor(context) } });
  }

  private async ensureOwnAccount(context: TenantContext, id: string) {
    const account = await this.prisma.account.findFirst({
      where: { id, ...this.tenantScope.byAuthor(context) },
    });
    if (!account) {
      throw new NotFoundException('Conta não encontrada');
    }
    return account;
  }

  private normalizeCardFields(dto: CreateAccountDto | UpdateAccountDto, type: AccountType) {
    const isCreditCard = type === 'credit_card';
    return {
      lastFourDigits: isCreditCard ? normalizeOptionalString(dto.lastFourDigits) : null,
      closingDay: isCreditCard ? dto.closingDay : null,
      dueDay: isCreditCard ? dto.dueDay : null,
    };
  }
}

function normalizeOptionalString(value?: string) {
  const normalized = value?.trim();
  return normalized || undefined;
}
