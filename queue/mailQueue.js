import { Queue } from "bullmq";
import { bullConnection } from "../config/redis.js";

export const mailQueue = new Queue("mail-queue", {
  connection: bullConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: "exponential",
      delay: 60000
    }
  }
});
