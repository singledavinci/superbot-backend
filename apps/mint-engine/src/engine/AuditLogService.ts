import type { PrismaClient } from '@superbot/database';

const SECRET_PATTERNS = [/0x[a-fA-F0-9]{64}/, /private[_-]?key/i, /seed/i, /mnemonic/i];

export class AuditLogService {
    constructor(private prisma: PrismaClient) {}

    private redact(msg: unknown): unknown {
        if (typeof msg === 'string') {
            let s = msg;
            for (const re of SECRET_PATTERNS) s = s.replace(re, '[REDACTED]');
            return s;
        }
        if (msg && typeof msg === 'object') {
            return JSON.parse(JSON.stringify(msg, (_k, v) => (typeof v === 'string' ? this.redact(v) : v)));
        }
        return msg;
    }

    async log(args: {
        mintJobId?: string | null;
        guildId?: string | null;
        userId?: string | null;
        action: string;
        status?: string | null;
        message?: string | null;
        metadata?: Record<string, unknown> | null;
    }): Promise<void> {
        const line = JSON.stringify({
            ts: new Date().toISOString(),
            type: 'mint_audit',
            ...args,
            message: args.message ? String(this.redact(args.message)) : undefined,
            metadata: args.metadata ? (this.redact(args.metadata) as Record<string, unknown>) : undefined,
        });
        console.log(line);
        try {
            await this.prisma.mintAuditLog.create({
                data: {
                    mintJobId: args.mintJobId ?? undefined,
                    guildId: args.guildId ?? undefined,
                    userId: args.userId ?? undefined,
                    action: args.action,
                    status: args.status ?? undefined,
                    message: args.message ? String(this.redact(args.message)) : undefined,
                    metadataJson: args.metadata ? (this.redact(args.metadata) as object) : undefined,
                },
            });
        } catch (e) {
            console.error('[AuditLogService] persist failed', e instanceof Error ? e.message : e);
        }
    }
}
