import IORedis from 'ioredis';
export declare const redisConnection: IORedis;
import { Queue } from 'bullmq';
export declare const eventQueue: Queue<any, any, string, any, any, string>;
export declare const discordQueue: Queue<any, any, string, any, any, string>;
//# sourceMappingURL=index.d.ts.map