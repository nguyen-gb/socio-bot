import { randomBytes, scryptSync } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const organizationId =
  process.env.DEFAULT_ORGANIZATION_ID ??
  '00000000-0000-4000-8000-000000000001';
const bootstrapPassword =
  process.env.BOOTSTRAP_ADMIN_PASSWORD ?? 'ChangeMe-Development-Only!';

if (process.env.NODE_ENV === 'production' && !process.env.BOOTSTRAP_ADMIN_PASSWORD) {
  throw new Error('BOOTSTRAP_ADMIN_PASSWORD is required when seeding production');
}

async function main(): Promise<void> {
  const organization = await prisma.organization.upsert({
    where: { id: organizationId },
    update: {},
    create: {
      id: organizationId,
      name: 'Socio Development',
      slug: 'socio-development',
    },
  });

  const existingUser = await prisma.user.findUnique({
    where: { email: 'owner@socio.local' },
  });
  const user = existingUser
    ? existingUser.passwordHash
      ? existingUser
      : await prisma.user.update({
          where: { id: existingUser.id },
          data: { passwordHash: hashPassword(bootstrapPassword) },
        })
    : await prisma.user.create({
        data: {
          email: 'owner@socio.local',
          displayName: 'Development Owner',
          passwordHash: hashPassword(bootstrapPassword),
          status: 'ACTIVE',
        },
      });

  await prisma.organizationMember.upsert({
    where: {
      organizationId_userId: {
        organizationId: organization.id,
        userId: user.id,
      },
    },
    update: { role: 'OWNER' },
    create: {
      organizationId: organization.id,
      userId: user.id,
      role: 'OWNER',
    },
  });

  console.info(`Seeded organization ${organization.id}`);
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

main()
  .finally(async () => prisma.$disconnect())
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
