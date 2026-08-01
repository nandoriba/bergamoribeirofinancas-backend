import { describe, expect, it, vi } from 'vitest';

import { TenantContext } from '../../shared/tenant-context';
import { ProfilesService } from './profiles.service';

describe('ProfilesService', () => {
  it('lists only active selector profiles from the authenticated family', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const tenantScope = { byFamily: vi.fn().mockReturnValue({ familyId: 'family-1' }) };
    const service = new ProfilesService({ memberProfile: { findMany } } as never, tenantScope as never);
    const context = TenantContext.fromAuthenticatedUser({
      id: 'platform-admin',
      email: 'admin@example.com',
      platformRole: 'admin',
      tenantRole: 'member',
      familyId: 'family-1',
      profileId: 'profile-1',
    });

    await service.listFamilyProfiles(context);

    expect(tenantScope.byFamily).toHaveBeenCalledWith(context);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { familyId: 'family-1', status: 'active' },
      }),
    );
  });
});
