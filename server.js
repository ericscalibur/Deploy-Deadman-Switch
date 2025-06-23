require("dotenv").config();

const express = require("express");
const path = require("path");
const authRoutes = require("./routes/auth");
const deadmanRoutes = require("./routes/deadman-minimal");

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// Routes
app.use("/auth", authRoutes);
app.use("/deadman", deadmanRoutes);

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

// Keep the process alive
const keepAliveInterval = setInterval(() => {
  // This prevents the process from exiting
}, 1000);

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  process.exit(1);
});

process.on("exit", (code) => {
  clearInterval(keepAliveInterval);
});
