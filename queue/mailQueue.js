import { Queue } from "bullmq";
import Redis from "ioredis";

const connection = new Redis({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT
});

export const mailQueue = new Queue("mail-queue", {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: "exponential",
      delay: 60000
    }
  }
});