import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { extname } from "node:path";
import { pipeline } from "node:stream/promises";

const permissions = [
  "realm-admin",
  "view-realm",
  "manage-realm",
  "query-realms",
  "view-identity-providers",
  "manage-identity-providers",
  "create-client",
  "manage-users",
  "view-authorization",
  "query-clients",
  "query-users",
  "manage-events",
  "view-events",
  "view-users",
  "view-clients",
  "manage-authorization",
  "manage-clients",
  "manage-organizations",
  "view-organizations",
  "query-groups",
  "query-organizations",
];

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function httpOrigin(value, name) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `${name} must be an HTTP(S) origin without a path or credentials`,
    );
  }
  return url;
}

function json(res, body) {
  res
    .writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    })
    .end(JSON.stringify(body));
}

function redirect(res) {
  res.writeHead(303, { Location: "/", "Cache-Control": "no-store" }).end();
}

function proxyHeaders(headers) {
  const result = { ...headers };
  for (const field of (headers.connection ?? "").split(",")) {
    delete result[field.trim().toLowerCase()];
  }
  for (const field of [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]) {
    delete result[field];
  }
  return result;
}

async function readJson(response) {
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function adaptWhoAmI(info, realm) {
  const global = info.realmAccess === "global";
  const realmAccess =
    global || (info.realmAccess === "realm" && realm === info.realm);
  return {
    realm: info.realm,
    userId: info.id,
    displayName: info.username,
    locale: "en",
    createRealm: global,
    temporary: false,
    realm_access: { [realm]: realmAccess ? permissions : [] },
  };
}

function adaptServerInfo(info) {
  return {
    ...info,
    systemInfo:
      info.systemInfo ?? (info.runtime && { version: info.runtime.version }),
    themes: Object.fromEntries(
      Object.entries(info.themes ?? {}).map(([type, themes]) => [
        type,
        themes.map((theme) =>
          typeof theme === "string" ? { name: theme } : theme,
        ),
      ]),
    ),
    providers: info.providers ?? {
      "login-protocol": { providers: { "openid-connect": {} } },
    },
  };
}

export function createConsoleServer({
  backendOrigin,
  rustPublicOrigin = backendOrigin,
  consoleOrigin,
  realm = "master",
  dist = new URL("../dist/", import.meta.url),
}) {
  const backend = httpOrigin(backendOrigin, "RUST_SERVER_URL");
  const upstreamOrigin = httpOrigin(
    rustPublicOrigin,
    "RUST_PUBLIC_ORIGIN",
  ).origin;
  const frontend = httpOrigin(consoleOrigin, "CONSOLE_ORIGIN");
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(realm)) {
    throw new Error("ADMIN_REALM must be a Rust realm name");
  }
  const request = backend.protocol === "https:" ? httpsRequest : httpRequest;

  function sameOrigin(req) {
    const [origin, duplicate] = req.headersDistinct.origin ?? [];
    return (
      origin === frontend.origin &&
      duplicate === undefined &&
      req.headers.host === frontend.host
    );
  }

  function sendUpstream(
    req,
    path,
    { forward = false, trustedOrigin = false } = {},
  ) {
    const headers = proxyHeaders(req.headers);
    headers.host = backend.host;
    for (const field of [
      "origin",
      "forwarded",
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-port",
      "x-forwarded-proto",
      "x-forwarded-prefix",
    ]) {
      delete headers[field];
    }
    if (trustedOrigin) headers.origin = upstreamOrigin;
    if (!forward || req.method === "GET" || req.method === "HEAD") {
      delete headers["content-length"];
    }
    delete headers["accept-encoding"];

    return new Promise((resolve, reject) => {
      const connection = request(
        backend,
        {
          path,
          method: forward ? req.method : "GET",
          headers,
          timeout: 15_000,
        },
        resolve,
      );
      connection.on("timeout", () =>
        connection.destroy(new Error("Rust server request timed out")),
      );
      connection.on("error", reject);
      if (forward && req.method !== "GET" && req.method !== "HEAD") {
        req.on("aborted", () => connection.destroy());
        req.pipe(connection);
      } else {
        connection.end();
      }
    });
  }

  async function proxy(req, res, pathname, search, searchParams) {
    const safe = req.method === "GET" || req.method === "HEAD";
    const trustedOrigin = sameOrigin(req);
    const sessionLogout = /^\/admin\/[^/]+\/console\/logout$/.test(pathname);
    if (
      (!safe && !trustedOrigin) ||
      (sessionLogout &&
        !trustedOrigin &&
        req.headers["sec-fetch-site"] !== "same-origin")
    ) {
      res.writeHead(403).end("Same-origin request required");
      return;
    }

    if (req.method === "GET" && /^\/admin\/[^/]+\/console$/.test(pathname)) {
      const identity = await sendUpstream(req, pathname + "/whoami");
      identity.resume();
      if (identity.statusCode === 200) {
        return redirect(res);
      }
    }

    const upstream = await sendUpstream(req, pathname + search, {
      forward: true,
      trustedOrigin,
    });
    if (req.method === "GET" && upstream.statusCode === 200) {
      if (
        /^\/admin\/[^/]+\/console\/whoami$/.test(pathname) &&
        searchParams.has("currentRealm")
      ) {
        return json(
          res,
          adaptWhoAmI(
            await readJson(upstream),
            searchParams.get("currentRealm"),
          ),
        );
      }
      if (/^\/admin\/realms\/[^/]+\/ui-ext\/info$/.test(pathname)) {
        return json(res, {
          userProfileProvidersEnabled: false,
          ...(await readJson(upstream)),
        });
      }
      if (pathname === "/admin/serverinfo") {
        return json(res, adaptServerInfo(await readJson(upstream)));
      }
    }
    const headers = proxyHeaders(upstream.headers);
    res.writeHead(upstream.statusCode, headers);
    await pipeline(upstream, res);
  }

  async function translations(req, res, realm, locale) {
    const upstream = await sendUpstream(
      req,
      `/admin/${realm}/console/messages.json?${new URLSearchParams({ locale })}`,
    );
    const base = await readFile(
      new URL(`messages/${locale}.json`, dist),
      "utf8",
    )
      .then(JSON.parse)
      .catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return {};
      });
    const overrides =
      upstream.statusCode === 200 ? await readJson(upstream) : {};
    upstream.resume();
    return json(
      res,
      Object.entries({ ...base, ...overrides }).map(([key, value]) => ({
        key,
        value,
      })),
    );
  }

  async function handle(req, res) {
    if (
      !req.url.startsWith("/") ||
      req.url.startsWith("//") ||
      req.url.includes("\\")
    ) {
      return res.writeHead(400).end("Invalid request target");
    }
    const url = new URL(req.url, frontend);
    const { search, searchParams } = url;
    const pathname = url.pathname.startsWith("/admin/")
      ? url.pathname.replace(/\/+$/, "")
      : url.pathname;
    const isRead = req.method === "GET" || req.method === "HEAD";
    if (isRead && pathname === "/admin") return redirect(res);
    if (req.method === "GET" && pathname === "/console-config.json")
      return json(res, { realm });

    const messages = pathname.match(
      /^\/resources\/([^/]+)\/admin\/([a-zA-Z0-9_-]+)$/,
    );
    if (req.method === "GET" && messages)
      return translations(req, res, messages[1], messages[2]);

    if (
      /^\/(?:admin|realms|welcome-content)\/|^\/resources\/v1\//.test(pathname)
    ) {
      return proxy(req, res, pathname, search, searchParams);
    }

    if (
      isRead &&
      (pathname === "/" ||
        /^\/(?:assets\/)?[\w.-]+\.[a-z0-9]+$/i.test(pathname))
    ) {
      const file = pathname === "/" ? "index.html" : pathname.slice(1);
      const location = new URL(file, dist);
      const info = await stat(location).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      if (info?.isFile()) {
        res.writeHead(200, {
          "Content-Type":
            contentTypes[extname(file)] ?? "application/octet-stream",
          "Content-Length": info.size,
          "Cache-Control": pathname.startsWith("/assets/")
            ? "public, max-age=31536000, immutable"
            : "no-store",
        });
        if (req.method === "HEAD") return res.end();
        return pipeline(createReadStream(location), res);
      }
    }
    res.writeHead(404).end("Not found");
  }

  return createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (error.code === "ERR_STREAM_PREMATURE_CLOSE") return;
      console.error(error.message);
      if (res.headersSent) res.destroy();
      else res.writeHead(502).end("The Rust server is unavailable.");
    });
  });
}
