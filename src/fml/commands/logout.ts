import { clearStoredCredentials } from "../auth/token-store.js";
import { getActiveEnv } from "../config.js";

export function handleLogout(): void {
  const { name } = getActiveEnv();
  clearStoredCredentials();
  console.log(`Logged out of "${name}". Stored credentials cleared.`);
}
