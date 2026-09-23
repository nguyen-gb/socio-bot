import { Inject, Injectable } from '@nestjs/common';
import type { ProfileSnapshotStore } from '@socio/object-storage';
import { PrismaService } from '../database/prisma.service';
import { PROFILE_SNAPSHOT_STORE } from './profile-snapshot.providers';

interface RestorableProfile {
  id: string;
  snapshotVersion: number;
  storageUri: string;
}

@Injectable()
export class ProfileSnapshotsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PROFILE_SNAPSHOT_STORE)
    private readonly snapshots: ProfileSnapshotStore,
  ) {}

  async restore(profile: RestorableProfile): Promise<void> {
    await this.snapshots.restore(
      profile.id,
      profile.snapshotVersion > 0 ? profile.storageUri : undefined,
    );
  }

  async capture(profileId: string): Promise<void> {
    const profile = await this.prisma.browserProfile.update({
      where: { id: profileId },
      data: { status: 'SNAPSHOTTING' },
      select: { snapshotVersion: true },
    });
    const version = profile.snapshotVersion + 1;

    try {
      const snapshot = await this.snapshots.snapshot(profileId, version);
      await this.prisma.$transaction([
        this.prisma.profileSnapshot.create({
          data: {
            profileId,
            version,
            storageUri: snapshot.storageUri,
            checksum: snapshot.checksum,
            sizeBytes: BigInt(snapshot.sizeBytes),
            encrypted: true,
          },
        }),
        this.prisma.browserProfile.update({
          where: { id: profileId },
          data: {
            storageUri: snapshot.storageUri,
            snapshotVersion: version,
            status: 'AVAILABLE',
          },
        }),
      ]);
    } catch (error) {
      await this.prisma.browserProfile.update({
        where: { id: profileId },
        data: { status: 'ERROR' },
      });
      throw error;
    }
  }
}
