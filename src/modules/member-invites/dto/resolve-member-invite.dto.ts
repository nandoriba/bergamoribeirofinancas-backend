import { IsString, Matches } from 'class-validator';

const INVITE_TOKEN_PATTERN = /^(?:[A-Fa-f0-9]{48}|[A-Za-z0-9_-]{43})$/;

export class ResolveMemberInviteDto {
  @IsString()
  @Matches(INVITE_TOKEN_PATTERN)
  token!: string;
}
