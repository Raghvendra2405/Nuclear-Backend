// Load .env into process.env before any other module reads env vars.
// Node 20.12+/22+/24 provides process.loadEnvFile natively.
try {
  process.loadEnvFile();
} catch {
  // No .env file present — rely on the real environment.
}
