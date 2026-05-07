"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.prisma = void 0;
exports.connectDB = connectDB;
const client_1 = require("@prisma/client");
const adapter_pg_1 = require("@prisma/adapter-pg");
const pg_1 = __importDefault(require("pg"));
const { Pool } = pg_1.default;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new adapter_pg_1.PrismaPg(pool);
exports.prisma = new client_1.PrismaClient({ adapter });
async function connectDB() {
    try {
        await exports.prisma.$connect();
        console.log('✅ Connected to PostgreSQL database via Prisma 7 (Adapter)');
    }
    catch (error) {
        console.error('❌ Failed to connect to database:', error);
        // In a microservice, we might want to retry rather than exit, 
        // but for now we keep the existing behavior.
        process.exit(1);
    }
}
//# sourceMappingURL=index.js.map