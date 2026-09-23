import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MinimumRole } from '../auth/roles.decorator';
import { OrganizationId } from '../common/organization-id.decorator';
import { MediaService, type UploadedMedia } from './media.service';

const ALLOWED_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
]);

@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Get()
  list(@OrganizationId() organizationId: string) {
    return this.media.list(organizationId);
  }

  @Get(':id')
  get(@OrganizationId() organizationId: string, @Param('id') id: string) {
    return this.media.get(organizationId, id);
  }

  @Post()
  @MinimumRole('OPERATOR')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024, files: 1 } }))
  create(
    @OrganizationId() organizationId: string,
    @UploadedFile() file?: UploadedMedia,
  ) {
    if (!file) throw new BadRequestException('A media file is required');
    if (!ALLOWED_MEDIA_TYPES.has(file.mimetype)) {
      throw new BadRequestException('Supported media types: JPEG, PNG, WebP, MP4');
    }
    return this.media.create(organizationId, file);
  }
}
