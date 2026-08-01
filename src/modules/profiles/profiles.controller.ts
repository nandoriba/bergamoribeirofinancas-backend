import { Controller, Get } from '@nestjs/common';

import { CurrentTenant } from '../../shared/current-tenant.decorator';
import type { TenantContext } from '../../shared/tenant-context';
import { ProfilesService } from './profiles.service';

@Controller('profiles')
export class ProfilesController {
  constructor(private readonly profilesService: ProfilesService) {}

  @Get()
  list(@CurrentTenant() context: TenantContext) {
    return this.profilesService.listFamilyProfiles(context);
  }
}
