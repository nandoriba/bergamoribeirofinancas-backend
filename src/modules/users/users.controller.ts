import { Body, Controller, Patch } from '@nestjs/common';

import { CurrentUser } from '../../shared/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';
import { UpdateThemeDto } from './dto/update-theme.dto';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Patch('me/theme')
  updateTheme(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateThemeDto) {
    return this.usersService.updateTheme(user, dto);
  }
}
