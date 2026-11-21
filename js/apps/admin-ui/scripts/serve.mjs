import { access } from "node:fs/promises";
import { createConsoleServer } from "./console-server.mjs";

const port = Number(process.env.PORT ?? 5174);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}
await access(new URL("../dist/index.html", import.meta.url)).catch(() => {
  throw new Error("Build the Admin Console before starting it");
});

const server = createConsoleServer({
  backendOrigin: process.env.RUST_SERVER_URL ?? "http://127.0.0.1:8080",
  rustPublicOrigin: process.env.RUST_PUBLIC_ORIGIN,
  consoleOrigin: process.env.CONSOLE_ORIGIN ?? `http://localhost:${port}`,
  realm: process.env.ADMIN_REALM,
});

server.listen(port, "0.0.0.0", () =>
  console.log(`Keycloak Admin Console listening on port ${port}`),
);
