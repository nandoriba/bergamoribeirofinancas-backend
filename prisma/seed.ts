import { PrismaClient, type AccountType, type CategoryType } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const categories: Array<{
  name: string;
  type: CategoryType;
  color: string;
  aliases: string[];
}> = [
  { name: 'Receitas', type: 'income', color: '#6ab397', aliases: ['salario', 'pix recebido', 'transferencia recebida'] },
  { name: 'Outros', type: 'income', color: '#7aa5d4', aliases: ['reembolso', 'rendimento'] },
  { name: 'Alimentação', type: 'expense', color: '#3d6cb0', aliases: ['ifood', 'mercado', 'padaria', 'restaurante'] },
  { name: 'Transporte', type: 'expense', color: '#5c89c4', aliases: ['uber', '99', 'posto', 'combustivel'] },
  { name: 'Moradia', type: 'expense', color: '#7aa5d4', aliases: ['aluguel', 'energia', 'agua', 'condominio'] },
  { name: 'Saúde', type: 'expense', color: '#9abfe2', aliases: ['farmacia', 'drogaria', 'consulta'] },
  { name: 'Educação', type: 'expense', color: '#b8d3ec', aliases: ['curso', 'escola', 'faculdade'] },
  { name: 'Assinaturas', type: 'expense', color: '#6a96d3', aliases: ['netflix', 'spotify', 'amazon', 'apple'] },
  { name: 'Cartão', type: 'expense', color: '#d99090', aliases: ['nubank', 'pagamento fatura'] },
  { name: 'Outros', type: 'expense', color: '#3a4a66', aliases: [] },
];

const accounts: Array<{
  name: string;
  type: AccountType;
  institution: string;
  initialBalanceCents: number;
  closingDay?: number;
  dueDay?: number;
}> = [
  { name: 'Nubank Conta', type: 'checking', institution: 'Nubank', initialBalanceCents: 0 },
  {
    name: 'Nubank Cartão',
    type: 'credit_card',
    institution: 'Nubank',
    initialBalanceCents: 0,
    closingDay: 25,
    dueDay: 2,
  },
];

async function main() {
  const familyName = process.env.FAMILY_NAME ?? 'Casa Ribeiro';
  const adminEmail = process.env.INITIAL_ADMIN_EMAIL ?? 'admin@casaribeiro.local';
  const adminName = process.env.INITIAL_ADMIN_NAME ?? 'Administrador';
  const adminPassword = process.env.INITIAL_ADMIN_PASSWORD ?? 'admin12345';

  const family =
    (await prisma.family.findFirst({ where: { name: familyName } })) ??
    (await prisma.family.create({ data: { name: familyName } }));

  const passwordHash = await bcrypt.hash(adminPassword, 12);
  const user = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {
      name: adminName,
      role: 'admin',
      isActive: true,
      familyId: family.id,
    },
    create: {
      email: adminEmail,
      name: adminName,
      passwordHash,
      role: 'admin',
      isActive: true,
      familyId: family.id,
    },
  });

  const profile =
    (await prisma.memberProfile.findUnique({ where: { userId: user.id } })) ??
    (await prisma.memberProfile.create({
      data: {
        displayName: adminName,
        status: 'active',
        userId: user.id,
        familyId: family.id,
      },
    }));

  for (const category of categories) {
    await prisma.category.upsert({
      where: {
        familyId_name_type: {
          familyId: family.id,
          name: category.name,
          type: category.type,
        },
      },
      update: { color: category.color, aliases: category.aliases },
      create: { ...category, familyId: family.id },
    });
  }

  for (const account of accounts) {
    const existing = await prisma.account.findFirst({
      where: { memberProfileId: profile.id, name: account.name },
    });
    if (!existing) {
      await prisma.account.create({
        data: {
          ...account,
          memberProfileId: profile.id,
        },
      });
    }
  }

  console.log(`Seed concluído para ${familyName} (${adminEmail}).`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
