import sql from "mssql";
import dotenv from "dotenv";

dotenv.config();

function normalizeConfig(raw) {
  return {
    user: raw.user,
    password: raw.password,
    server: raw.server,
    database: raw.database,
    options: {
      encrypt: false,
      trustServerCertificate: true,
      ...(raw.options || {})
    }
  };
}

function readConfig(prefix, fallbackPrefix) {
  const user = process.env[`${prefix}_USER`] || (fallbackPrefix ? process.env[`${fallbackPrefix}_USER`] : undefined);
  const password = process.env[`${prefix}_PASS`] || process.env[`${prefix}_PASSWORD`] || (fallbackPrefix ? process.env[`${fallbackPrefix}_PASS`] || process.env[`${fallbackPrefix}_PASSWORD`] : undefined);
  const server = process.env[`${prefix}_SERVER`] || (fallbackPrefix ? process.env[`${fallbackPrefix}_SERVER`] : undefined);
  const database = process.env[`${prefix}_NAME`] || process.env[`${prefix}_DATABASE`] || (fallbackPrefix ? process.env[`${fallbackPrefix}_NAME`] || process.env[`${fallbackPrefix}_DATABASE`] : undefined);

  return normalizeConfig({ user, password, server, database });
}

const configs = {
  local: readConfig("DB", "SQL"),
  prod: readConfig("PROD_DB"),
  test: readConfig("TEST_DB"),
  express: readConfig("EXPRESS_DB", "DB")
};

function ensureTarget(target = "local") {
  if (!configs[target]) {
    throw new Error(`Target de DB no soportado: ${target}`);
  }

  const cfg = configs[target];
  if (!cfg.server || !cfg.database) {
    throw new Error(`Configuración incompleta para target '${target}'. Revisá variables de entorno.`);
  }

  return cfg;
}

async function runWithPool(target, runner) {
  const config = ensureTarget(target);
  const pool = new sql.ConnectionPool(config);
  await pool.connect();
  try {
    return await runner(pool);
  } finally {
    await pool.close();
  }
}

export async function sqlQuery(text, inputs = [], target = "local") {
  return runWithPool(target, async pool => {
    const request = pool.request();
    for (const input of inputs) {
      request.input(input.name, input.type, input.value);
    }
    const result = await request.query(text);
    return result.recordset;
  });
}

export async function executeProcedure(name, inputs = [], target = "local") {
  return runWithPool(target, async pool => {
    const request = pool.request();
    for (const input of inputs) {
      request.input(input.name, input.type, input.value);
    }
    return request.execute(name);
  });
}

export async function query(q) {
  return runWithPool("local", pool => pool.request().query(q));
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
