import { Controller, Get } from '@nestjs/common';

import { CurrentUser } from '../../shared/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';
import { ProfilesService } from './profiles.service';

@Controller('profiles')
export class ProfilesController {
  constructor(private readonly profilesService: ProfilesService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.profilesService.listFamilyProfiles(user);
  }
}
