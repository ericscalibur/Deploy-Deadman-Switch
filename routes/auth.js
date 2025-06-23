const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { promisify } = require("util");
const pbkdf2 = promisify(crypto.pbkdf2);

const { readUser, writeUser } = require("../models/user"); // functions to read and write to user json files

const secretKey = process.env.SECRET_KEY; // Use environment variable

// Helper function to generate a unique 6-digit code
function generateCode() {
  return Math.floor(100000 + Math.random() * 900000);
}

// Route for user signup
router.post("/signup", async (req, res) => {
  const { email, password } = req.body;

  // Basic validation
  if (!email || !password) {
    return res.status(400).json({ message: "Email and password are required" });
  }

  try {
    // Check if user already exists
    const existingUser = await readUser(email);
    if (existingUser) {
      return res.status(409).json({ message: "User already exists" });
    }

    // Hash the password using PBKDF2
    const salt = crypto.randomBytes(16).toString("hex");
    const hashedPassword = await pbkdf2(password, salt, 1000, 32, "sha256");

    // Create a new user object
    const newUser = {
      email,
      salt,
      password: hashedPassword.toString("hex"),
    };

    // Save the new user to the JSON file
    await writeUser(email, newUser);

    res.status(201).json({ message: "User created successfully" });
  } catch (error) {
    console.error("Error during signup:", error);
    res.status(500).json({ message: "Failed to create user" });
  }
});

// Route for user login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  // Basic validation
  if (!email || !password) {
    return res.status(400).json({ message: "Email and password are required" });
  }

  try {
    // Retrieve the user from the JSON file
    const user = await readUser(email);
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // Hash the provided password using the user's salt
    const hashedPassword = await pbkdf2(
      password,
      user.salt,
      1000,
      32,
      "sha256",
    );

    // Compare the hashed password with the stored password
    if (hashedPassword.toString("hex") !== user.password) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // Generate a JWT token
    const token = jwt.sign({ email: user.email }, secretKey, {
      expiresIn: "1h",
    });

    res.status(200).json({ message: "Login successful", token });
  } catch (error) {
    console.error("Error during login:", error);
    res.status(500).json({ message: "Failed to login" });
  }
});

// Route for forgot password
router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ message: "Email is required" });
  }

  try {
    // Retrieve the user from the JSON file
    const user = await readUser(email);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Generate a unique 6-digit code
    const resetCode = generateCode();

    // TODO: Store the reset code securely (e.g., in a database or in-memory cache)
    // and associate it with the user's email.  Also, set an expiration time
    // for the reset code.

    // TODO: Send the reset code to the user's email address

    res.status(200).json({ message: "Reset code sent to your email address" });
  } catch (error) {
    console.error("Error during forgot password:", error);
    res
      .status(500)
      .json({ message: "Failed to process forgot password request" });
  }
});

module.exports = router;
