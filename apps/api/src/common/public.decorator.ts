import { SetMetadata } from '@nestjs/common';

export const PUBLIC_ENDPOINT = Symbol('PUBLIC_ENDPOINT');
export const Public = () => SetMetadata(PUBLIC_ENDPOINT, true);
