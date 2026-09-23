import { ConfigService } from '@nestjs/config';
import { ProfileSnapshotStore, parseProfileEncryptionKey } from '@socio/object-storage';
import type { ObjectStorage } from '@socio/object-storage';
import type { WorkerEnvironment } from '../config/environment';
import { OBJECT_STORAGE } from './object-storage.providers';

export const PROFILE_SNAPSHOT_STORE = Symbol('PROFILE_SNAPSHOT_STORE');

export const profileSnapshotStoreProvider = {
  provide: PROFILE_SNAPSHOT_STORE,
  inject: [ConfigService, OBJECT_STORAGE],
  useFactory: (
    config: ConfigService<WorkerEnvironment, true>,
    objects: ObjectStorage,
  ) =>
    new ProfileSnapshotStore(
      objects,
      config.get('profileRoot', { infer: true }),
      config.get('artifactRoot', { infer: true }),
      parseProfileEncryptionKey(
        config.get('profileEncryptionKey', { infer: true }),
      ),
    ),
};
