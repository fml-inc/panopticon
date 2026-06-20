import fs from "node:fs";
import { authStorePath } from "../config.js";

export function handleLogout(): void {
  try {
    fs.unlinkSync(authStorePath());
  } catch {
    // File doesn't exist, that's fine
  }
  console.log("Logged out. Stored credentials cleared.");
}
