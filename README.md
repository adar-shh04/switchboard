# Switchboard

A resilient, multi-tenant shared team inbox built with Node.js/TypeScript, Express, MongoDB, Redis, WebSockets, and React.

## Prerequisites
- Node.js 22+
- Docker Desktop (for MongoDB, Redis, Pigeon, and Mock IdP)

## Run from a Clean Clone

1. **Start infrastructure & simulators:**
   ```bash
   npm run up
   ```
   Verify all services are healthy:
   ```bash
   npm run doctor
   ```

2. **Install dependencies:**
   ```bash
   npm run scaffold:install
   ```

3. **Run the server and React frontend:**
   In one terminal:
   ```bash
   npm run scaffold:server
   ```
   In a second terminal:
   ```bash
   npm run scaffold:web
   ```
   Open `http://localhost:5173` and sign in via the Mock IdP (e.g., `Ben Ortiz` or `Asha Rao`).

4. **Simulate customer messages:**
   ```bash
   npm run inbound
   ```

## Running Tests & Checks
- **Unit tests:**
  ```bash
  npm --prefix scaffold/server test
  ```
- **Automated harness check** (stop your dev server on `:4000` first):
  ```bash
  npm run check        # Level 1 (~90s)
  npm run check:full   # Levels 1, 2, 3, 5 (~4m)
  ```
