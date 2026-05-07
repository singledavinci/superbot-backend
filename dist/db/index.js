"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.prisma = void 0;
exports.connectDB = connectDB;
const client_1 = require("@prisma/client");
const adapter_pg_1 = require("@prisma/adapter-pg");
const pg_1 = require("pg");
const pool = new pg_1.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new adapter_pg_1.PrismaPg(pool);
exports.prisma = new client_1.PrismaClient({ adapter });
async function connectDB() {
    try {
        await exports.prisma.$connect();
        console.log('✅ Connected to PostgreSQL database via Prisma 7 (Adapter)');
    }
    catch (error) {
        console.error('❌ Failed to connect to database:', error);
        process.exit(1);
    }
}
