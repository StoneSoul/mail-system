import sql from "mssql";
import dotenv from "dotenv";

dotenv.config();

const poolCache = new Map();

function readBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "y"].includes(String(value).toLowerCase());
}

function normalizeConfig(raw) {
  return {
    user: raw.user,
    password: raw.password,
    server: raw.server,
    database: raw.database,
    pool: {
      max: Number(raw.poolMax || process.env.DB_POOL_MAX || 10),
      min: Number(raw.poolMin || process.env.DB_POOL_MIN || 0),
      idleTimeoutMillis: Number(raw.poolIdleMs || process.env.DB_POOL_IDLE_MS || 30000)
    },
    options: {
      encrypt: readBoolean(raw.encrypt ?? process.env.DB_ENCRYPT, false),
      trustServerCertificate: readBoolean(raw.trustServerCertificate ?? process.env.DB_TRUST_SERVER_CERTIFICATE, true)
    }
  };
}

function readConfig(prefix, fallbackPrefix) {
  const user = process.env[`${prefix}_USER`] || (fallbackPrefix ? process.env[`${fallbackPrefix}_USER`] : undefined);
  const password =
    process.env[`${prefix}_PASS`] ||
    process.env[`${prefix}_PASSWORD`] ||
    (fallbackPrefix ? process.env[`${fallbackPrefix}_PASS`] || process.env[`${fallbackPrefix}_PASSWORD`] : undefined);
  const server = process.env[`${prefix}_SERVER`] || (fallbackPrefix ? process.env[`${fallbackPrefix}_SERVER`] : undefined);
  const database =
    process.env[`${prefix}_NAME`] ||
    process.env[`${prefix}_DATABASE`] ||
    (fallbackPrefix ? process.env[`${fallbackPrefix}_NAME`] || process.env[`${fallbackPrefix}_DATABASE`] : undefined);

  return normalizeConfig({ user, password, server, database });
}

const configs = {
  local: readConfig("DB", "SQL"),
  prod: readConfig("PROD_DB"),
  test: readConfig("TEST_DB"),
  express: readConfig("EXPRESS_DB", "DB")
};

function ensureTarget(target = "local") {
  const cfg = configs[target];
  if (!cfg) throw new Error(`Target de DB no soportado: ${target}`);

  if (!cfg.server || !cfg.database) {
    throw new Error(`Configuración incompleta para target '${target}'. Definí ${target.toUpperCase()}_DB_* o DB_*.`);
  }

  return cfg;
}

export async function getPool(target = "local") {
  if (poolCache.has(target)) {
    return poolCache.get(target);
  }

  const cfg = ensureTarget(target);
  const pool = new sql.ConnectionPool(cfg);
  const poolConnectPromise = pool.connect();
  pool.on("error", () => {
    poolCache.delete(target);
  });
  poolCache.set(target, poolConnectPromise);
  return poolConnectPromise;
}

function bindInputs(request, inputs = []) {
  for (const input of inputs) {
    if (!input || !input.name) continue;
    if (input.type) {
      request.input(input.name, input.type, input.value);
      continue;
    }
    request.input(input.name, input.value);
  }
}

export async function sqlQuery(text, inputs = [], target = "local") {
  const pool = await getPool(target);
  const request = pool.request();
  bindInputs(request, inputs);
  const result = await request.query(text);
  const rows = Array.isArray(result?.recordset) ? result.recordset : [];
  return Object.assign(rows, {
    recordset: rows,
    rowsAffected: result?.rowsAffected || [],
    output: result?.output || {}
  });
}

export async function executeProcedure(name, inputs = [], target = "local") {
  const pool = await getPool(target);
  const request = pool.request();
  bindInputs(request, inputs);
  return request.execute(name);
}

export async function query(text, target = "local") {
  return sqlQuery(text, [], target);
}

export async function closeAllPools() {
  const closures = [];
  for (const promise of poolCache.values()) {
    closures.push(
      promise
        .then(pool => pool.close())
        .catch(() => undefined)
    );
  }
  poolCache.clear();
  await Promise.all(closures);
}

export function getDbTargetsSummary() {
  return {
    local: {
      server: configs.local.server || null,
      database: configs.local.database || null,
      configured: Boolean(configs.local.server && configs.local.database)
    },
    prod: {
      server: configs.prod.server || null,
      database: configs.prod.database || null,
      configured: Boolean(configs.prod.server && configs.prod.database)
    },
    test: {
      server: configs.test.server || null,
      database: configs.test.database || null,
      configured: Boolean(configs.test.server && configs.test.database)
    },
    express: {
      server: configs.express.server || null,
      database: configs.express.database || null,
      configured: Boolean(configs.express.server && configs.express.database)
    }
  };
}

export { sql };
