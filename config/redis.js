import Redis from "ioredis";
import dotenv from "dotenv";

dotenv.config();

export const redisConfig = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379)
};

export function getBullConnectionOptions() {
  return {
    ...redisConfig,
    maxRetriesPerRequest: null
  };
}

export function createRedisConnection() {
  return new Redis(getBullConnectionOptions());
}
