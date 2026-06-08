import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { UpdateInvoiceDto } from './dto/update-invoice.dto';

@Injectable()
export class InvoicesService {
  constructor(private readonly prisma: PrismaService) {}

  list(user: AuthenticatedUser) {
    return this.prisma.invoice.findMany({
      where: { memberProfile: { familyId: user.familyId } },
      include: { account: true },
      orderBy: { referenceMonth: 'desc' },
    });
  }

  async create(user: AuthenticatedUser, dto: CreateInvoiceDto) {
    const account = await this.prisma.account.findFirst({
      where: { id: dto.accountId, memberProfileId: user.profileId, type: 'credit_card' },
    });
    if (!account) throw new BadRequestException('Cartão inválido');

    return this.prisma.invoice.create({
      data: {
        referenceMonth: new Date(dto.referenceMonth),
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
        closingDate: dto.closingDate ? new Date(dto.closingDate) : undefined,
        totalCents: dto.totalCents ?? 0,
        status: dto.status ?? 'open',
        accountId: dto.accountId,
        memberProfileId: user.profileId,
      },
    });
  }

  async update(user: AuthenticatedUser, id: string, dto: UpdateInvoiceDto) {
    await this.ensureInvoice(user, id);
    return this.prisma.invoice.update({
      where: { id },
      data: {
        ...dto,
        referenceMonth: dto.referenceMonth ? new Date(dto.referenceMonth) : undefined,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
        closingDate: dto.closingDate ? new Date(dto.closingDate) : undefined,
      },
    });
  }

  async remove(user: AuthenticatedUser, id: string) {
    await this.ensureInvoice(user, id);
    return this.prisma.invoice.delete({ where: { id } });
  }

  private async ensureInvoice(user: AuthenticatedUser, id: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, memberProfile: { familyId: user.familyId } },
    });
    if (!invoice) throw new NotFoundException('Fatura não encontrada');
    return invoice;
  }
}

