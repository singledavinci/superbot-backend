import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);

export const prisma = new PrismaClient({ adapter });

export async function connectDB() {
    try {
        await prisma.$connect();
        console.log('✅ Connected to PostgreSQL database via Prisma 7 (Adapter)');
    } catch (error) {
        console.error('❌ Failed to connect to database:', error);
        // In a microservice, we might want to retry rather than exit, 
        // but for now we keep the existing behavior.
        process.exit(1);
    }
}
