#!/bin/bash

set -e

# Properties for the Start9 dashboard.
#
# Output MUST be `{"version": 2, "data": {...}}` where every entry is a typed
# object ({type: "string", value: ...}) — StartOS 0.4 validates this shape
# strictly (0.3.x used the same format; the old flat-JSON output of this
# script never matched it). Reads state from the `main` volume, which must be
# declared as a mount on the properties procedure in manifest.yaml.

ENV_FILE="/app/data/.env"

exec node - << 'EOF'
const fs = require("fs");

function readEnv(path) {
  const env = {};
  try {
    for (const line of fs.readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) env[m[1]] = m[2];
    }
  } catch (e) { /* not configured yet */ }
  return env;
}

const env = readEnv("/app/data/.env");

let version = "unknown";
try { version = require("/app/package.json").version; } catch (e) {}

const provider = env.EMAIL_PROVIDER || null;
const configured = !!(env.EMAIL_USER || env.SMTP_HOST);
const appUrl = env.APP_URL || null;

const str = (value, description, extra = {}) => ({
  type: "string",
  value: String(value),
  description,
  copyable: false,
  qr: false,
  masked: false,
  ...extra,
});

const data = {
  "Version": str(version, "Deploy Deadman Switch version"),
  "Status": str(
    configured ? "Configured" : "Not configured — set email credentials in Config",
    "Whether an email transport has been configured",
  ),
};

if (provider) {
  data["Email Provider"] = str(provider, "SMTP transport used for check-in and deadman emails");
}
if (appUrl) {
  data["Service URL"] = str(appUrl, "Base URL used in check-in email links", {
    copyable: true,
    qr: true,
  });
}

process.stdout.write(JSON.stringify({ version: 2, data }));
EOF
