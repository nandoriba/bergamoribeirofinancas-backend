import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.types';

@Injectable()
export class ProfilesService {
  constructor(private readonly prisma: PrismaService) {}

  listFamilyProfiles(user: AuthenticatedUser) {
    return this.prisma.memberProfile.findMany({
      where: {
        familyId: user.familyId,
        status: 'active',
      },
      select: {
        id: true,
        displayName: true,
        status: true,
        user: {
          select: {
            email: true,
            role: true,
          },
        },
      },
      orderBy: { displayName: 'asc' },
    });
  }
}

