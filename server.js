require("dotenv").config();

const express = require("express");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const cookieParser = require("cookie-parser");

const app = express();
const port = process.env.PORT || 3000;
const httpsPort = process.env.HTTPS_PORT || 443;
const httpPort = process.env.HTTP_PORT || 80;

// Trust Start9's reverse proxy so x-forwarded-proto is read correctly
app.set("trust proxy", 1);

// HTTPS redirect middleware (only in production, and only if proxy says HTTP)
app.use((req, res, next) => {
  if (
    process.env.NODE_ENV === "production" &&
    req.header("x-forwarded-proto") === "http"
  ) {
    res.redirect(`https://${req.header("host")}${req.url}`);
  } else {
    next();
  }
});

// Security headers middleware
app.use((req, res, next) => {
  res.setHeader(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains; preload",
  );
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';",
  );
  next();
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

// Health check endpoint for Docker/Start9 (no config needed)
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    service: "deadman-switch",
  });
});

// --- Config helpers ---

function applyConfigToEnv(config) {
  const map = {
    email_provider: "EMAIL_PROVIDER",
    gmail_user: "EMAIL_USER",
    gmail_password: "EMAIL_PASS",
    smtp_host: "SMTP_HOST",
    smtp_port: "SMTP_PORT",
    smtp_user: "SMTP_USER",
    smtp_password: "SMTP_PASS",
    app_url: "APP_URL",
  };
  for (const [cfgKey, envKey] of Object.entries(map)) {
    const val = config[cfgKey];
    if (val !== null && val !== undefined && val !== "") {
      process.env[envKey] = String(val);
    }
  }
}

async function loadConfigFromDB() {
  const sqlite3 = require("sqlite3").verbose();
  const { DB_PATH } = require("./database/init");
  return new Promise((resolve) => {
    const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, (err) => {
      if (err) {
        console.log("Config DB not ready yet, using .env defaults");
        return resolve();
      }
      db.get("SELECT value FROM settings WHERE key = 'config'", (err, row) => {
        db.close();
        if (err || !row) return resolve();
        try {
          const config = JSON.parse(row.value);
          applyConfigToEnv(config);
          console.log("Config loaded from database");
        } catch (e) {
          console.log("Failed to parse saved config:", e.message);
        }
        resolve();
      });
    });
  });
}

function isLocalhost(req) {
  const addr = req.socket.remoteAddress;
  return (
    addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1"
  );
}

// --- Async startup: load DB config before routes initialize emailService ---

(async () => {
  await loadConfigFromDB();

  const deadmanRoutes = require("./routes/deadman");
  app.use("/deadman", deadmanRoutes);

  // Internal config API — used by configurator.sh via inject:true network sharing
  const emailService = require("./utils/emailService");
  const sqlite3 = require("sqlite3").verbose();
  const { DB_PATH } = require("./database/init");

  app.get("/internal/config", (req, res) => {
    if (!isLocalhost(req)) return res.status(403).end();
    const db = new sqlite3.Database(DB_PATH);
    db.get("SELECT value FROM settings WHERE key = 'config'", (err, row) => {
      db.close();
      if (err || !row) return res.json({});
      try {
        res.json(JSON.parse(row.value));
      } catch (e) {
        res.json({});
      }
    });
  });

  app.post("/internal/config", (req, res) => {
    if (!isLocalhost(req)) return res.status(403).end();
    const config = req.body;
    if (!config || typeof config !== "object") {
      return res.status(400).json({ error: "Invalid body" });
    }
    const db = new sqlite3.Database(DB_PATH);
    db.run(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('config', ?)",
      [JSON.stringify(config)],
      (err) => {
        db.close();
        if (err) return res.status(500).json({ error: err.message });
        applyConfigToEnv(config);
        emailService.reinitialize().catch((e) => {
          console.error("Email reinit failed:", e.message);
        });
        res.json({ ok: true });
      },
    );
  });

  // Start servers
  if (
    process.env.NODE_ENV === "production" &&
    process.env.SSL_KEY_PATH &&
    process.env.SSL_CERT_PATH
  ) {
    try {
      const privateKey = fs.readFileSync(process.env.SSL_KEY_PATH, "utf8");
      const certificate = fs.readFileSync(process.env.SSL_CERT_PATH, "utf8");
      const credentials = { key: privateKey, cert: certificate };

      const httpsServer = https.createServer(credentials, app);
      httpsServer.listen(httpsPort, () => {
        console.log(`HTTPS Server is running on port ${httpsPort}`);
      });

      const httpApp = express();
      httpApp.use((req, res) => {
        res.redirect(`https://${req.headers.host}${req.url}`);
      });
      const httpServer = http.createServer(httpApp);
      httpServer.listen(httpPort, () => {
        console.log(
          `HTTP Server is running on port ${httpPort} (redirects to HTTPS)`,
        );
      });
    } catch (error) {
      console.error("SSL certificate error:", error.message);
      app.listen(port, () => {
        console.log(`Server is running on HTTP port ${port}`);
      });
    }
  } else {
    app.listen(port, () => {
      console.log(`Server is running on port ${port}`);
    });
  }
})().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  process.exit(1);
});

process.on("exit", (code) => {
  console.log(`Process exiting with code: ${code}`);
});
