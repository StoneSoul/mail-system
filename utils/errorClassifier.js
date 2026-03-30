const RULES = [
  {
    category: "RATE_LIMIT_HOURLY",
    patterns: [/rate\s*limit/i, /too\s+many\s+requests/i, /4\.7\.0/i, /throttl/i, /daily\s+user\s+sending\s+quota/i],
    retryable: true,
    allowFallback: true
  },
  {
    category: "MAILBOX_NOT_FOUND",
    patterns: [/mailbox\s+unavailable/i, /user\s+unknown/i, /recipient\s+address\s+rejected/i, /5\.1\.1/i, /no\s+such\s+user/i],
    retryable: false,
    allowFallback: false
  },
  {
    category: "MAILBOX_FULL",
    patterns: [/mailbox\s+full/i, /quota\s+exceeded/i, /over\s+quota/i, /5\.2\.2/i],
    retryable: true,
    allowFallback: false
  },
  {
    category: "AUTH",
    patterns: [/auth/i, /authentication/i, /invalid\s+login/i, /535\s+5\.7\.8/i],
    retryable: false,
    allowFallback: true
  },
  {
    category: "DNS",
    patterns: [/enotfound/i, /dns/i, /getaddrinfo/i, /resolve/i],
    retryable: true,
    allowFallback: true
  },
  {
    category: "CONNECTION",
    patterns: [/econnreset/i, /econnrefused/i, /socket\s+closed/i, /connection\s+timed\s+out/i],
    retryable: true,
    allowFallback: true
  },
  {
    category: "TEMPORARY",
    patterns: [/timeout/i, /temporar/i, /try\s+again\s+later/i, /4\.\d\.\d/i],
    retryable: true,
    allowFallback: false
  },
  {
    category: "HARD",
    patterns: [/5\.\d\.\d/i, /permanent\s+failure/i, /policy\s+violation/i, /blocked/i],
    retryable: false,
    allowFallback: false
  }
];

function errorText(err) {
  const message = err?.message || err?.response || err?.code || "";
  return String(message);
}

export function classifyError(err) {
  const text = errorText(err);

  for (const rule of RULES) {
    if (rule.patterns.some(pattern => pattern.test(text))) {
      return {
        category: rule.category,
        retryable: rule.retryable,
        allowFallback: rule.allowFallback,
        detail: text
      };
    }
  }

  return {
    category: "UNKNOWN",
    retryable: true,
    allowFallback: false,
    detail: text || "Error sin detalle"
  };
}
