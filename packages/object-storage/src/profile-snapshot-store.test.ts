import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalObjectStorage } from './object-storage';
import { ProfileSnapshotStore } from './profile-snapshot-store';

test('encrypted profile snapshot round-trips through object storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'socio-profile-test-'));
  const profiles = join(root, 'profiles');
  const objects = join(root, 'objects');
  const temporary = join(root, 'tmp');
  const profileId = '00000000-0000-4000-8000-000000000123';
  const profilePath = join(profiles, profileId);
  const store = new ProfileSnapshotStore(
    new LocalObjectStorage(objects),
    profiles,
    temporary,
    Buffer.alloc(32, 7),
  );

  try {
    await mkdir(profilePath, { recursive: true });
    await writeFile(join(profilePath, 'state.json'), '{"loggedIn":true}');
    const snapshot = await store.snapshot(profileId, 1);
    assert.match(snapshot.storageUri, /#v=1&iv=/);
    assert.equal(snapshot.checksum.length, 64);

    await writeFile(join(profilePath, 'state.json'), '{"loggedIn":false}');
    await store.restore(profileId, snapshot.storageUri);
    assert.equal(await readFile(join(profilePath, 'state.json'), 'utf8'), '{"loggedIn":true}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
