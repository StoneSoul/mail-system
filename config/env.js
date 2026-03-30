import dotenv from "dotenv";

dotenv.config();

export function requireEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Variable de entorno requerida ausente: ${name}`);
  }
  return String(value).trim();
}

export function getEnv(name, fallback = undefined) {
  const value = process.env[name];
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

export function getEnvNumber(name, fallback) {
  const raw = getEnv(name, fallback);
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Variable ${name} debe ser numérica.`);
  }
  return value;
}

export function getEnvBoolean(name, fallback = false) {
  const raw = getEnv(name, fallback ? "true" : "false");
  return ["1", "true", "yes", "y"].includes(String(raw).toLowerCase());
}
