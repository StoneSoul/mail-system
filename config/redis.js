import Redis from "ioredis";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });

export const redisConfig = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379)
};

export const bullConnection = {
  ...redisConfig,
  maxRetriesPerRequest: null
};

export function createRedisConnection() {
  return new Redis(bullConnection);
}
