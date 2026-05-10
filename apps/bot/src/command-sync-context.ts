export type GuildSlashSyncResult = {
    ok: boolean;
    status?: number;
    message?: string;
    commandCount?: number;
};

type SyncFn = (guildId: string) => Promise<GuildSlashSyncResult>;

let syncGuildCommands: SyncFn | null = null;

export function registerGuildSlashCommandSync(fn: SyncFn): void {
    syncGuildCommands = fn;
}

export async function refreshGuildSlashCommands(guildId: string): Promise<GuildSlashSyncResult> {
    if (!syncGuildCommands) {
        return { ok: false, message: 'Command sync is not initialized yet (bot still starting).' };
    }
    return syncGuildCommands(guildId);
}
