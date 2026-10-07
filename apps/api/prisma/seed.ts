import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

try {
  await prisma.game.upsert({
    where: { slug: 'cs2' },
    update: { name: 'Counter-Strike 2', steamAppId: 730 },
    create: { slug: 'cs2', name: 'Counter-Strike 2', steamAppId: 730 },
  });
  console.info('Seeded CS2 (Steam app 730).');
} finally {
  await prisma.$disconnect();
}
