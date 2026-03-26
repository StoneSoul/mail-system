const DEFAULT_SMTP_HOST = process.env.SMTP_HOST || "smtp.hostinger.com";
const DEFAULT_SMTP_PORT = Number(process.env.SMTP_PORT || 465);

export const smtpAccounts = {
  imcenvio: {
    key: "imcenvio",
    provider: "hostinger",
    fromEmail: "imcenvio@enviosimc.info",
    auth: { user: "imcenvio@enviosimc.info", pass: "Envios123456!" }
  },
  imcenvio1: {
    key: "imcenvio1",
    provider: "hostinger",
    fromEmail: "imcenvio1@enviosimc.info",
    auth: { user: "imcenvio1@enviosimc.info", pass: "Envios123456!" }
  },
  imcenvio2: {
    key: "imcenvio2",
    provider: "hostinger",
    fromEmail: "imcenvio2@enviosimc.info",
    auth: { user: "imcenvio2@enviosimc.info", pass: "Envios123456!" }
  },
  imcenvio3: {
    key: "imcenvio3",
    provider: "hostinger",
    fromEmail: "imcenvio3@enviosimc.info",
    auth: { user: "imcenvio3@enviosimc.info", pass: "Envios123456!" }
  },
  imcenvio4: {
    key: "imcenvio4",
    provider: "hostinger",
    fromEmail: "imcenvio4@enviosimc.info",
    auth: { user: "imcenvio4@enviosimc.info", pass: "Envios123456!" }
  },
  imcinformes: {
    key: "imcinformes",
    provider: "hostinger",
    fromEmail: "imcinformes@enviosimc.info",
    auth: { user: "imcinformes@enviosimc.info", pass: "Envios123456!" }
  },
  informeslaboratorio: {
    key: "informeslaboratorio",
    provider: "hostinger",
    fromEmail: "informeslaboratorio@enviosimc.info",
    auth: { user: "informeslaboratorio@enviosimc.info", pass: "Envios123456!" }
  },
  profesionales: {
    key: "profesionales",
    provider: "hostinger",
    fromEmail: "profesionales@enviosimc.info",
    auth: { user: "profesionales@enviosimc.info", pass: "Envios123456!" }
  },
  "no-responder": {
    key: "no-responder",
    provider: "hostinger",
    fromEmail: "no-responder@enviosimc.info",
    auth: { user: "no-responder@enviosimc.info", pass: "noreply1.IMC!" }
  },
  agendas: {
    key: "agendas",
    provider: "hostinger",
    fromEmail: "agendas@enviosimc.info",
    auth: { user: "agendas@enviosimc.info", pass: "cance2016IMC!" }
  }
};

export const senderProfileToAccount = {
  default: "imcenvio",
  onboarding: "imcenvio",
  facturacion: "imcinformes",
  informes: "informeslaboratorio",
  profesionales: "profesionales",
  agendas: "agendas",
  "no-responder": "no-responder"
};

export function resolveSmtpAccount(senderProfile) {
  const profileKey = String(senderProfile || "default").trim().toLowerCase();
  const accountKey = senderProfileToAccount[profileKey] || profileKey || "default";

  const account = smtpAccounts[accountKey] || smtpAccounts[senderProfileToAccount.default];

  return {
    host: DEFAULT_SMTP_HOST,
    port: DEFAULT_SMTP_PORT,
    secure: true,
    ...account
  };
}
