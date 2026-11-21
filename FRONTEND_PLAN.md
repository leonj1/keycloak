# Standalone React Admin Console migration

The React Admin Console in this fork runs against an independently deployed Rust identity server.
The frontend workspace includes the console, shared UI, and Admin API client.
The Rust server provides authentication, authorization, and persistent data.
The console host serves the frontend assets and forwards same-origin browser requests to Rust.

## 1. Establish the baseline

- [x] Run the existing preview against Rust v0.1.0.
  Verify in Chromium that an administrator can sign in, load Clients and Users, and sign out, and that the host rejects an off-origin write.
  The existing smoke test passed against Rust v0.1.0.

## 2. Build the console as a standalone application

- [x] Add a Vite HTML entry point, wire the Rust session into React, and package the existing UI assets and message bundles.
  Run a frozen pnpm install and verify that Vite produces `js/apps/admin-ui/dist/index.html` and every file referenced by it without a Java build.
  The install and build passed, every HTML asset reference resolved, and all 30 locale bundles were present.

## 3. Connect the standalone host to Rust

- [x] Add configurable upstream and public origins, forward the Rust browser session, and adapt the Admin API shapes used by the console.
  Verify static assets, upstream errors, session responses, and same-origin write enforcement with HTTP tests.
  Sign in through Chromium, create and edit a disposable user and client, then sign out.
  The HTTP proxy test passed.
  Chromium created and disabled a user, created a public OIDC client and updated its redirect URI, verified both changes through Rust, cleaned up both records, and confirmed logout.

## 4. Switch development and CI to frontend commands

- [x] Document installation, building, serving, and testing.
  Add a frontend workflow and run its commands locally before removing the Java modules.
  Frozen install, build, type checking, 118 unit tests, and the proxy contract test passed with the Java modules still present.

## 5. Remove Java and upstream build infrastructure

- [x] Remove the Java modules, Maven packaging, and upstream tests and tooling tied to the Java distribution.
  Keep the standalone Rust checkout and its planning artifacts outside the frontend repository's tracked files.
  Build and test from a fresh export containing only the retained frontend repository files.
  Run the Chromium acceptance test from the fresh build against the separately running Rust service.
  The export passed frozen install, build, type checking, 128 unit tests, the proxy contract test, and the Chromium acceptance test.
