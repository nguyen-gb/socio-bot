import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LocalObjectStorage, S3ObjectStorage } from '@socio/object-storage';
import type { ApiEnvironment } from '../config/environment';

export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

@Global()
@Module({
  providers: [
    {
      provide: OBJECT_STORAGE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<ApiEnvironment, true>) =>
        config.get('objectStorageDriver', { infer: true }) === 's3'
          ? new S3ObjectStorage({
              endpoint: config.get('s3Endpoint', { infer: true }),
              region: config.get('s3Region', { infer: true }),
              bucket: config.get('s3Bucket', { infer: true }),
              accessKeyId: config.get('s3AccessKey', { infer: true }),
              secretAccessKey: config.get('s3SecretKey', { infer: true }),
              forcePathStyle: config.get('s3ForcePathStyle', { infer: true }),
            })
          : new LocalObjectStorage(config.get('objectStorageRoot', { infer: true })),
    },
  ],
  exports: [OBJECT_STORAGE],
})
export class ObjectStorageModule {}
