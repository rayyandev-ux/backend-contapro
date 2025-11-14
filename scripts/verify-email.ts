import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  try {
    const args = process.argv.slice(2);
    const emailArgIndex = args.findIndex((a) => a === '--email');
    const email = emailArgIndex >= 0 ? String(args[emailArgIndex + 1] || '') : '';
    if (!email) {
      console.error('Uso: tsx scripts/verify-email.ts --email usuario@correo.com');
      process.exit(1);
    }
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!re.test(email)) {
      console.error('Email inválido');
      process.exit(1);
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      console.error('Usuario no encontrado');
      process.exit(1);
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        verificationCode: null,
        verificationExpires: null,
      },
    });
    console.log(`Verificado: ${email}`);
  } catch (e: any) {
    console.error('Error:', e?.message || e);
    process.exit(1);
  }
}

main();