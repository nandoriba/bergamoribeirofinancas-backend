import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import { UpdateThemeDto } from './dto/update-theme.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  updateTheme(user: AuthenticatedUser, dto: UpdateThemeDto) {
    return this.prisma.user.update({
      where: { id: user.id },
      data: { themePreference: dto.themePreference },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        themePreference: true,
      },
    });
  }
}

