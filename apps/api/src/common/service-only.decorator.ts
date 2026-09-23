import { SetMetadata } from '@nestjs/common';

export const SERVICE_ONLY = Symbol('SERVICE_ONLY');
export const ServiceOnly = () => SetMetadata(SERVICE_ONLY, true);
