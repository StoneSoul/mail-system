import { getEnv, getEnvBoolean, getEnvNumber, requireEnv } from "./env.js";

function parseJsonEnv(name, fallback = null) {
  const raw = getEnv(name);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`JSON inválido en ${name}`);
  }
}

function normalizeAccount(key, account) {
  if (!account?.host) throw new Error(`Cuenta SMTP '${key}' sin host`);
  if (!account?.auth?.user) throw new Error(`Cuenta SMTP '${key}' sin auth.user`);
  if (!account?.auth?.pass) throw new Error(`Cuenta SMTP '${key}' sin auth.pass`);

  return {
    key,
    provider: account.provider || "smtp",
    host: account.host,
    port: Number(account.port || 465),
    secure: account.secure !== undefined ? Boolean(account.secure) : true,
    fromEmail: account.fromEmail || account.auth.user,
    auth: {
      user: account.auth.user,
      pass: account.auth.pass
    },
    priority: Number(account.priority || 100),
    cooldownSeconds: Number(account.cooldownSeconds || 0)
  };
}

function loadAccounts() {
  const jsonAccounts = parseJsonEnv("SMTP_ACCOUNTS_JSON");
  if (jsonAccounts && typeof jsonAccounts === "object") {
    const normalized = {};
    for (const [key, account] of Object.entries(jsonAccounts)) {
      normalized[key.toLowerCase()] = normalizeAccount(key.toLowerCase(), account);
    }
    return normalized;
  }

  const defaultUser = requireEnv("SMTP_USER");
  const defaultPass = requireEnv("SMTP_PASS");
  const defaultHost = requireEnv("SMTP_HOST");
  const defaultPort = getEnvNumber("SMTP_PORT", 465);
  const defaultSecure = getEnvBoolean("SMTP_SECURE", true);
  const defaultFrom = getEnv("SMTP_FROM", defaultUser);

  return {
    default: normalizeAccount("default", {
      host: defaultHost,
      port: defaultPort,
      secure: defaultSecure,
      fromEmail: defaultFrom,
      auth: { user: defaultUser, pass: defaultPass },
      provider: "default"
    })
  };
}

const smtpAccounts = loadAccounts();
const defaultAccountKey = getEnv("SMTP_DEFAULT_ACCOUNT", "default").toLowerCase();

if (!smtpAccounts[defaultAccountKey]) {
  throw new Error(`SMTP_DEFAULT_ACCOUNT='${defaultAccountKey}' no existe en SMTP_ACCOUNTS_JSON`);
}

const senderProfileToAccount = Object.entries(parseJsonEnv("SENDER_PROFILE_MAP_JSON", { default: defaultAccountKey })).reduce(
  (acc, [profile, account]) => {
    const profileKey = String(profile).toLowerCase();
    const accountKey = String(account).toLowerCase();
    if (!smtpAccounts[accountKey]) {
      throw new Error(`Perfil '${profileKey}' apunta a cuenta SMTP inexistente '${accountKey}'`);
    }
    acc[profileKey] = accountKey;
    return acc;
  },
  {}
);

if (!senderProfileToAccount.default) {
  senderProfileToAccount.default = defaultAccountKey;
}

export function resolveSmtpAccount(senderProfile) {
  const profileKey = String(senderProfile || "default").trim().toLowerCase();
  const accountKey = senderProfileToAccount[profileKey] || senderProfileToAccount.default;
  return smtpAccounts[accountKey];
}

export function resolveCandidateAccounts(senderProfile, allowFallback = false) {
  const primary = resolveSmtpAccount(senderProfile);
  if (!allowFallback) return [primary];

  const sorted = Object.values(smtpAccounts)
    .filter(item => item.key !== primary.key)
    .sort((a, b) => a.priority - b.priority);

  return [primary, ...sorted];
}

export { smtpAccounts, senderProfileToAccount };
