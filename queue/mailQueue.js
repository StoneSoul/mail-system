import { Queue } from "bullmq";
import { bullConnection } from "../config/redis.js";

export const mailQueue = new Queue("mail-queue", {
  connection: bullConnection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: 1000,
    removeOnFail: 1000
  }
});
