import { UserRole } from '@prisma/client';

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
  familyId: string;
  profileId: string;
}

export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  familyId: string;
  profileId: string;
}

