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
  const normalizedAdminEmail = adminEmail.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(adminPassword, 12);
  const { family, profile } = await prisma.$transaction(async (transaction) => {
    const existingUser = await transaction.user.findUnique({
      where: { email: normalizedAdminEmail },
      include: { family: true, profile: true },
    });

    if (!existingUser) {
      const sameNameFamily = await transaction.family.findFirst({ where: { name: familyName } });
      if (sameNameFamily) {
        throw new Error('Seed recusado: família existente sem correspondência unívoca pelo e-mail do owner.');
      }

      const createdFamily = await transaction.family.create({ data: { name: familyName } });
      const createdUser = await transaction.user.create({
        data: {
          email: normalizedAdminEmail,
          name: adminName,
          passwordHash,
          platformRole: 'admin',
          isActive: true,
          familyId: createdFamily.id,
        },
      });
      const createdProfile = await transaction.memberProfile.create({
        data: {
          displayName: adminName,
          status: 'active',
          userId: createdUser.id,
          familyId: createdFamily.id,
        },
      });
      const ownedFamily = await transaction.family.update({
        where: { id: createdFamily.id },
        data: { ownerUserId: createdUser.id },
      });

      return { family: ownedFamily, profile: createdProfile };
    }

    if (existingUser.profile && existingUser.profile.familyId !== existingUser.familyId) {
      throw new Error('Seed recusado: perfil do owner pertence a outra família.');
    }
    if (existingUser.family.ownerUserId && existingUser.family.ownerUserId !== existingUser.id) {
      throw new Error('Seed recusado: a família existente já possui outro owner.');
    }

    const updatedUser = await transaction.user.update({
      where: { id: existingUser.id },
      data: {
        name: adminName,
        platformRole: 'admin',
        isActive: true,
      },
    });
    const upsertedProfile = existingUser.profile
      ? await transaction.memberProfile.update({
          where: { id: existingUser.profile.id },
          data: { displayName: adminName, status: 'active' },
        })
      : await transaction.memberProfile.create({
          data: {
            displayName: adminName,
            status: 'active',
            userId: updatedUser.id,
            familyId: updatedUser.familyId,
          },
        });
    const ownedFamily = await transaction.family.update({
      where: { id: existingUser.familyId },
      data: { name: familyName, ownerUserId: existingUser.id },
    });

    return { family: ownedFamily, profile: upsertedProfile };
  });

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

  console.log(`Seed concluído para ${familyName} (${normalizedAdminEmail}).`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
