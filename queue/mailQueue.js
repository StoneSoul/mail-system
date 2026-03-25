import { Queue } from "bullmq";
import { createRedisConnection } from "../config/redis.js";

const connection = createRedisConnection();

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
