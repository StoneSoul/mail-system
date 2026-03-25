export function classifyError(err) {
  const msg = err.message.toLowerCase();

  if (msg.includes("550") || msg.includes("user unknown")) return "HARD";
  if (msg.includes("mailbox full")) return "SOFT";
  if (msg.includes("timeout")) return "SOFT";

  return "SOFT";
}