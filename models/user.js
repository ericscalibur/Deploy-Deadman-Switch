const fs = require("fs").promises;
const path = require("path");

const dataDirectory = path.join(__dirname, "../data"); // Directory to store user data
const userFileExtension = ".json";

// Helper function to ensure the data directory exists
async function ensureDataDirectoryExists() {
  try {
    await fs.mkdir(dataDirectory, { recursive: true });
  } catch (error) {
    // Error creating data directory
    throw error;
  }
}

// Function to read user data from a JSON file
async function readUser(email) {
  await ensureDataDirectoryExists(); // Ensure the directory exists
  const filePath = path.join(dataDirectory, `${email}${userFileExtension}`);

  try {
    const data = await fs.readFile(filePath, "utf8");
    return JSON.parse(data);
  } catch (error) {
    if (error.code === "ENOENT") {
      // User file not found
      return null;
    } else {
      // User file not found - return null
      throw error;
    }
  }
}

// Function to write user data to a JSON file
async function writeUser(email, userData) {
  await ensureDataDirectoryExists(); // Ensure the directory exists
  const filePath = path.join(dataDirectory, `${email}${userFileExtension}`);

  try {
    const data = JSON.stringify(userData, null, 2); // Pretty print JSON
    await fs.writeFile(filePath, data, "utf8");
  } catch (error) {
    // Error writing user file
    throw error;
  }
}

module.exports = {
  readUser,
  writeUser,
};
