import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);

export const prisma = new PrismaClient({ adapter });

export async function connectDB() {
    try {
        await prisma.$connect();
        console.log('✅ Connected to PostgreSQL database via Prisma 7 (Adapter)');
    } catch (error) {
        console.error('❌ Failed to connect to database:', error);
        process.exit(1);
    }
}
