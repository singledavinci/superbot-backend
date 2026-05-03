import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

export async function connectDB() {
    try {
        await prisma.$connect();
        console.log('✅ Connected to PostgreSQL database via Prisma');
    } catch (error) {
        console.error('❌ Failed to connect to database:', error);
        process.exit(1);
    }
}
