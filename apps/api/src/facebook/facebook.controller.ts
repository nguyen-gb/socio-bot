import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { joinFacebookGroupsSchema, postFacebookGroupsSchema, syncFacebookGroupsSchema, retryFacebookCampaignSchema, type JoinFacebookGroupsInput, type PostFacebookGroupsInput, type RetryFacebookCampaignInput } from '@socio/contracts';
import { OrganizationId } from '../common/organization-id.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { MinimumRole } from '../auth/roles.decorator';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import type { AuthPrincipal } from '../auth/auth.types';
import { FacebookService } from './facebook.service';

@Controller('facebook')
export class FacebookController {
  constructor(private readonly facebook: FacebookService) {}
  @Get('groups') groups(@OrganizationId() org: string) { return this.facebook.groups(org); }
  @Get('campaigns') campaigns(@OrganizationId() org: string) { return this.facebook.campaigns(org); }
  @Post('groups/sync') @MinimumRole('OPERATOR')
  sync(@OrganizationId() org: string, @Body(new ZodValidationPipe(syncFacebookGroupsSchema)) input: { accountIds: string[]; idempotencyKey: string }) { return this.facebook.sync(org, input); }
  @Post('groups/join') @MinimumRole('OPERATOR')
  join(@OrganizationId() org: string, @Body(new ZodValidationPipe(joinFacebookGroupsSchema)) input: JoinFacebookGroupsInput) { return this.facebook.join(org, input); }
  @Post('groups/post') @MinimumRole('OPERATOR')
  post(@OrganizationId() org: string, @Body(new ZodValidationPipe(postFacebookGroupsSchema)) input: PostFacebookGroupsInput) { return this.facebook.post(org, input); }
  @Post('campaigns/:id/approve') @MinimumRole('ADMIN')
  approve(@OrganizationId() org: string, @Param('id', new ParseUUIDPipe()) id: string, @CurrentPrincipal() principal: AuthPrincipal) { return this.facebook.approve(org, id, principal.userId); }
  @Post('campaigns/:id/cancel') @MinimumRole('ADMIN')
  cancel(@OrganizationId() org: string, @Param('id', new ParseUUIDPipe()) id: string) { return this.facebook.cancel(org, id); }
  @Post('campaigns/:id/pause') @MinimumRole('ADMIN')
  pause(@OrganizationId() org: string, @Param('id', new ParseUUIDPipe()) id: string) { return this.facebook.pause(org, id); }
  @Post('campaigns/:id/resume') @MinimumRole('ADMIN')
  resume(@OrganizationId() org: string, @Param('id', new ParseUUIDPipe()) id: string) { return this.facebook.resume(org, id); }
  @Post('campaigns/:id/retry') @MinimumRole('ADMIN')
  retry(@OrganizationId() org: string, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(retryFacebookCampaignSchema)) input: RetryFacebookCampaignInput) { return this.facebook.retry(org, id, input); }
}
