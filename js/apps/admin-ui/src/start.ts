import type { Environment } from "./environment-types";

type Administrator = {
  username: string;
  realm: string;
};

async function start() {
  const config = await fetch("/console-config.json");
  if (!config.ok) throw new Error("Could not load console configuration");
  const { realm }: { realm: string } = await config.json();
  const consolePath = `/admin/${encodeURIComponent(realm)}/console`;

  const response = await fetch(consolePath + "/whoami", { cache: "no-store" });
  if (response.status === 401) {
    window.location.replace(consolePath);
    return;
  }
  if (!response.ok) throw new Error("Admin session check failed");
  const administrator: Administrator = await response.json();
  const origin = window.location.origin;
  const environment: Environment = {
    serverBaseUrl: origin,
    adminBaseUrl: origin,
    consoleBaseUrl: origin + "/",
    realm: administrator.realm,
    masterRealm: "master",
    clientId: "rust-admin-session",
    darkMode: false,
    logo: "",
    logoUrl: "",
    resourceUrl: origin,
    resourceVersion: "standalone",
    administratorName: administrator.username,
  };
  const script = document.createElement("script");
  script.id = "environment";
  script.type = "application/json";
  script.textContent = JSON.stringify(environment);
  document.body.append(script);
  await import("./main");
}

try {
  await start();
} catch (error) {
  console.error(error);
  const alert = document.createElement("p");
  alert.setAttribute("role", "alert");
  alert.textContent = "The Admin Console could not connect to the Rust server.";
  document.getElementById("app")?.replaceChildren(alert);
}
