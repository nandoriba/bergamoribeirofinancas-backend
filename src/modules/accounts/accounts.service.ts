import { Injectable, NotFoundException } from '@nestjs/common';

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
        ...dto,
        initialBalanceCents: dto.initialBalanceCents ?? 0,
        memberProfileId: user.profileId,
      },
    });
  }

  async update(user: AuthenticatedUser, id: string, dto: UpdateAccountDto) {
    await this.ensureAccount(user, id);
    return this.prisma.account.update({ where: { id }, data: dto });
  }

  async remove(user: AuthenticatedUser, id: string) {
    await this.ensureAccount(user, id);
    return this.prisma.account.delete({ where: { id } });
  }

  private async ensureAccount(user: AuthenticatedUser, id: string) {
    const account = await this.prisma.account.findFirst({
      where: { id, memberProfile: { familyId: user.familyId } },
    });
    if (!account) {
      throw new NotFoundException('Conta não encontrada');
    }
    return account;
  }
}
