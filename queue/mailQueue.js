import { Queue } from "bullmq";
import { createRedisConnection } from "../config/redis.js";

function buildQueueOptions() {
  const connection = createRedisConnection();

  if (!connection) {
    throw new Error("No se pudo inicializar la conexión Redis para la cola");
  }

  return { connection };
}

export const mailQueue = new Queue("mail-queue", {
  ...buildQueueOptions(),
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: "exponential",
      delay: 60000
    }
  }
});
