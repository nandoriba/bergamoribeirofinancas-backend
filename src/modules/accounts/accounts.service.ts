import { Injectable, NotFoundException } from '@nestjs/common';
import type { AccountType } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';

@Injectable()
export class AccountsService {
  constructor(private readonly prisma: PrismaService) {}

  list(user: AuthenticatedUser) {
    return this.prisma.account.findMany({
      where: { memberProfile: { familyId: user.familyId } },
      include: { memberProfile: { select: { id: true, displayName: true } } },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    });
  }

  create(user: AuthenticatedUser, dto: CreateAccountDto) {
    return this.prisma.account.create({
      data: {
        name: dto.name.trim(),
        type: dto.type,
        institution: normalizeOptionalString(dto.institution),
        ...this.normalizeCardFields(dto, dto.type),
        initialBalanceCents: dto.initialBalanceCents ?? 0,
        memberProfileId: user.profileId,
      },
    });
  }

  async update(user: AuthenticatedUser, id: string, dto: UpdateAccountDto) {
    const account = await this.ensureOwnAccount(user, id);
    const nextType = dto.type ?? account.type;
    return this.prisma.account.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        type: dto.type,
        institution: normalizeOptionalString(dto.institution),
        ...this.normalizeCardFields(dto, nextType),
        initialBalanceCents: dto.initialBalanceCents,
      },
    });
  }

  async remove(user: AuthenticatedUser, id: string) {
    await this.ensureOwnAccount(user, id);
    return this.prisma.account.delete({ where: { id } });
  }

  private async ensureOwnAccount(user: AuthenticatedUser, id: string) {
    const account = await this.prisma.account.findFirst({
      where: { id, memberProfileId: user.profileId },
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
