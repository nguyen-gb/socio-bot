import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { facebookGroupCollectionSchema, facebookOptInRecipientSchema, joinFacebookGroupsSchema, messageFacebookRecipientsSchema, postFacebookGroupsSchema, replyFacebookPostCommentsSchema, scanFacebookPostCommentsSchema, syncFacebookGroupsSchema, retryFacebookCampaignSchema, type FacebookGroupCollectionInput, type FacebookOptInRecipientInput, type JoinFacebookGroupsInput, type MessageFacebookRecipientsInput, type PostFacebookGroupsInput, type ReplyFacebookPostCommentsInput, type RetryFacebookCampaignInput, type ScanFacebookPostCommentsInput, type SyncFacebookGroupsInput } from '@socio/contracts';
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
  @Get('group-collections') groupCollections(@OrganizationId() org: string) { return this.facebook.groupCollections(org); }
  @Post('group-collections') @MinimumRole('OPERATOR')
  createGroupCollection(@OrganizationId() org: string, @Body(new ZodValidationPipe(facebookGroupCollectionSchema)) input: FacebookGroupCollectionInput) { return this.facebook.createGroupCollection(org, input); }
  @Patch('group-collections/:id') @MinimumRole('OPERATOR')
  updateGroupCollection(@OrganizationId() org: string, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(facebookGroupCollectionSchema)) input: FacebookGroupCollectionInput) { return this.facebook.updateGroupCollection(org, id, input); }
  @Delete('group-collections/:id') @MinimumRole('ADMIN')
  deleteGroupCollection(@OrganizationId() org: string, @Param('id', new ParseUUIDPipe()) id: string) { return this.facebook.deleteGroupCollection(org, id); }
  @Get('opt-in-recipients') optInRecipients(@OrganizationId() org: string) { return this.facebook.optInRecipients(org); }
  @Post('opt-in-recipients') @MinimumRole('OPERATOR')
  createOptInRecipient(@OrganizationId() org: string, @Body(new ZodValidationPipe(facebookOptInRecipientSchema)) input: FacebookOptInRecipientInput) { return this.facebook.createOptInRecipient(org, input); }
  @Patch('opt-in-recipients/:id') @MinimumRole('OPERATOR')
  updateOptInRecipient(@OrganizationId() org: string, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(facebookOptInRecipientSchema)) input: FacebookOptInRecipientInput) { return this.facebook.updateOptInRecipient(org, id, input); }
  @Delete('opt-in-recipients/:id') @MinimumRole('OPERATOR')
  revokeOptInRecipient(@OrganizationId() org: string, @Param('id', new ParseUUIDPipe()) id: string) { return this.facebook.revokeOptInRecipient(org, id); }
  @Post('opt-in-recipients/:id/reactivate') @MinimumRole('OPERATOR')
  reactivateOptInRecipient(@OrganizationId() org: string, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(facebookOptInRecipientSchema)) input: FacebookOptInRecipientInput) { return this.facebook.updateOptInRecipient(org, id, input, true); }
  @Get('campaigns') campaigns(@OrganizationId() org: string) { return this.facebook.campaigns(org); }
  @Post('groups/sync') @MinimumRole('OPERATOR')
  sync(@OrganizationId() org: string, @Body(new ZodValidationPipe(syncFacebookGroupsSchema)) input: SyncFacebookGroupsInput) { return this.facebook.sync(org, input); }
  @Post('groups/join') @MinimumRole('OPERATOR')
  join(@OrganizationId() org: string, @Body(new ZodValidationPipe(joinFacebookGroupsSchema)) input: JoinFacebookGroupsInput) { return this.facebook.join(org, input); }
  @Post('groups/post') @MinimumRole('OPERATOR')
  post(@OrganizationId() org: string, @Body(new ZodValidationPipe(postFacebookGroupsSchema)) input: PostFacebookGroupsInput) { return this.facebook.post(org, input); }
  @Post('groups/message') @MinimumRole('OPERATOR')
  message(@OrganizationId() org: string, @Body(new ZodValidationPipe(messageFacebookRecipientsSchema)) input: MessageFacebookRecipientsInput) { return this.facebook.message(org, input); }
  @Post('posts/scan-comments') @MinimumRole('OPERATOR')
  scanComments(@OrganizationId() org: string, @Body(new ZodValidationPipe(scanFacebookPostCommentsSchema)) input: ScanFacebookPostCommentsInput) { return this.facebook.scanComments(org, input); }
  @Post('posts/reply-comments') @MinimumRole('OPERATOR')
  replyComments(@OrganizationId() org: string, @Body(new ZodValidationPipe(replyFacebookPostCommentsSchema)) input: ReplyFacebookPostCommentsInput) { return this.facebook.replyComments(org, input); }
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
