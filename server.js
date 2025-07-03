require("dotenv").config();

const express = require("express");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const cookieParser = require("cookie-parser");
const authRoutes = require("./routes/auth");
const deadmanRoutes = require("./routes/deadman-minimal");

const app = express();
const port = process.env.PORT || 3000;
const httpsPort = process.env.HTTPS_PORT || 443;
const httpPort = process.env.HTTP_PORT || 80;

// HTTPS redirect middleware (only in production)
app.use((req, res, next) => {
  if (
    process.env.NODE_ENV === "production" &&
    req.header("x-forwarded-proto") !== "https"
  ) {
    res.redirect(`https://${req.header("host")}${req.url}`);
  } else {
    next();
  }
});

// Security headers middleware
app.use((req, res, next) => {
  // Strict Transport Security - enforce HTTPS for 1 year
  res.setHeader(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains; preload",
  );

  // Prevent loading in frames (clickjacking protection)
  res.setHeader("X-Frame-Options", "DENY");

  // Prevent MIME type sniffing
  res.setHeader("X-Content-Type-Options", "nosniff");

  // XSS protection
  res.setHeader("X-XSS-Protection", "1; mode=block");

  // Referrer policy
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  // Content Security Policy - prevent XSS
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

// Routes
app.use("/auth", authRoutes);
app.use("/deadman", deadmanRoutes);

// Start servers
if (
  process.env.NODE_ENV === "production" &&
  process.env.SSL_KEY_PATH &&
  process.env.SSL_CERT_PATH
) {
  // HTTPS server with SSL certificates
  try {
    const privateKey = fs.readFileSync(process.env.SSL_KEY_PATH, "utf8");
    const certificate = fs.readFileSync(process.env.SSL_CERT_PATH, "utf8");
    const credentials = { key: privateKey, cert: certificate };

    // HTTPS server
    const httpsServer = https.createServer(credentials, app);
    httpsServer.listen(httpsPort, () => {
      console.log(`HTTPS Server is running on port ${httpsPort}`);
    });

    // HTTP server that redirects to HTTPS
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
  // Development or non-SSL production server
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
}

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
