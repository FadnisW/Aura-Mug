# ☕ AURA — Editorial Ceramic Storefront & UPI Payment Gateway Integration

<div align="center">

![AURA Hero Banner](public/assets/aura-mug.svg)

### *A minimalist, high-craft e-commerce storefront featuring real-time hosted UPI checkout, automated OTP verification, and signed webhook reconciliation.*

[![Node.js Version](https://img.shields.io/badge/Node.js-%3E%3D24.0.0-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Architecture](https://img.shields.io/badge/Zero--Dependency-Server-000000?style=for-the-badge&logo=javascript&logoColor=white)](#-architecture--design-principles)
[![Database](https://img.shields.io/badge/SQLite-WAL--Mode-003B57?style=for-the-badge&logo=sqlite&logoColor=white)](#-database--storage)
[![Payment](https://img.shields.io/badge/UPI--PG-Simulated%20Gateway-6C5CE7?style=for-the-badge)](#-payment-architecture--lifecycle)
[![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)](LICENSE)

[Live Demo Walkthrough](#-how-the-payment-flow-works) • [System Architecture](#-system-architecture) • [Security & Compliance](#-security-hardening) • [Quick Start](#-quick-start)

---

</div>

## 🌟 Overview

**AURA** is a production-grade single-product boutique storefront engineered around the [UPI-PG](https://github.com/devstroop/UPI-PG) decentralized payment gateway protocol. Built with an obsessive focus on minimalism, raw web standards, and cryptographic verification, AURA delivers an end-to-end luxury retail experience without the bloat of traditional heavy commerce stacks.

### Key Highlights
- ⚡ **Zero Runtime NPM Dependencies**: Powered exclusively by modern Node.js 24 built-ins (`node:http`, `node:sqlite`, `node:crypto`).
- 💳 **Hosted UPI Gateway Checkout**: Complete payment session lifecycle with WhatsApp OTP simulation, dynamic QR display, and instant bank-credit SMS injection.
- 🔐 **Cryptographically Signed Webhooks**: Dual HMAC-SHA256 signature verification (supporting both V1 & V2 timestamped schemes) with replay-attack defenses.
- 📦 **Browser-Local Order Isolation**: Zero-account checkout with 32-byte cryptographic token pairing stored in client `localStorage` and constant-time server authentication.

---

## 🏗️ Architecture & Design Principles

```
┌─────────────────┐       HTTP / JSON        ┌─────────────────────────┐
│                 │ ───────────────────────> │                         │
│  Client Browser │                          │    AURA Store Server    │
│  (ES Modules)   │ <─────────────────────── │  (Node:http + SQLite)   │
└────────┬────────┘     Server-Side State    └────────────┬────────────┘
         │                                                │
         │ Redirect (Session Active)                      │ Order Creation &
         │                                                │ Reconcile Poll
         v                                                v
┌─────────────────────────┐                  ┌─────────────────────────┐
│   UPI-PG Checkout UI    │ <──────────────> │    UPI-PG Payment API   │
│     (:7000 Portal)      │   Signed Webhook │     (:6100 Gateway)     │
└─────────────────────────┘                  └─────────────────────────┘
```

### 1. Zero Dependency Philosophy
The entire storefront backend runs without `express`, `fastify`, or third-party ORMs. All routing, static file serving with MIME negotiation, validation, and database queries utilize standard Node.js standard libraries:
- `node:http` for high-throughput native server handling.
- `node:sqlite` for transactional SQLite database storage with Write-Ahead Logging (WAL).
- `node:crypto` for constant-time comparison, HMAC signature generation, and token generation.

### 2. Client-Side Isolation
There are no user accounts or persistent server-side customer sessions. Orders are bound to a cryptographically secure 32-byte `accessToken`. The server stores only the `SHA-256` hash of this token, ensuring receipts and order history are accessible only to the originating browser.

---

## 🔄 Payment Architecture & Lifecycle

AURA implements a multi-channel payment reconciliation pattern where the **webhook is authoritative** and client polling acts as a zero-latency fallback:

```text
Browser                  AURA Server (:5000)          UPI-PG API (:6100)       Hosted Checkout (:7000)
   │                            │                             │                          │
   │  1. POST /api/orders       │                             │                          │
   │───────────────────────────>│  Create PENDING order       │                          │
   │                            │  POST /api/v1/payments      │                          │
   │                            │────────────────────────────>│                          │
   │                            │  Returns checkoutUrl + ID   │                          │
   │                            │<────────────────────────────│                          │
   │  2. Redirect to Checkout   │                             │                          │
   │<───────────────────────────│                             │                          │
   │                                                                                     │
   │  3. Verify Mobile Number via Simulated OTP                                          │
   │────────────────────────────────────────────────────────────────────────────────────>│
   │                                                                                     │
   │                            4. Auto-Confirm Worker pushes test SMS                   │
   │                            │────────────────────────────>│                          │
   │                            │                             │ Parse credit & verify    │
   │                            │  5. POST /api/webhooks      │                          │
   │                            │<────────────────────────────│ Signed HMAC Webhook      │
   │                            │ Verify HMAC, Mark PAID      │                          │
   │                                                          │                          │
   │  6. Redirect to /return    │                             │                          │
   │<────────────────────────────────────────────────────────────────────────────────────│
   │                                                                                     │
   │  7. GET /api/orders/:id?refresh=1 (Reconciliation)                                  │
   │───────────────────────────>│ Order state confirmed PAID                             │
   │  Displays Official Receipt │                                                        │
   │<───────────────────────────│                                                        │
```

---

## 🛡️ Security Hardening

- **Authoritative Server-Side Pricing**: The client never passes price or amount parameters. The server calculates amounts strictly via `quantity * catalogPrice` in paise.
- **Strict Content Security Policy (CSP)**: Zero inline scripts or styles (`no 'unsafe-inline'`). All logic is structured as standard external ES modules.
- **Dual Webhook Signature Verification**:
  - `X-Gateway-Signature-V2`: Validates `HMAC-SHA256("${timestamp}.${rawBody}", secret)` preventing replay and time-skew attacks.
  - Replay prevention tracking unique `delivery_id` hashes in SQLite.
- **Defensive HTTP Headers**: Enforces `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Cross-Origin-Resource-Policy: same-origin`, and `Referrer-Policy: strict-origin-when-cross-origin`.

---

## 📂 Repository Structure

```text
aura-upi-store/
├── server.js                 # Entrypoint: HTTP server initialization
├── src/
│   ├── config.js             # Environment parsing and validation
│   ├── http.js               # Route dispatching, security headers & static files
│   ├── orders.js             # State machine, order queries & token checks
│   ├── db.js                 # SQLite schema migrations and prepared statements
│   ├── gateway.js            # UPI-PG client client bindings
│   ├── webhooks.js           # Cryptographic signature validation & processing
│   ├── auto-confirm.js       # Background synthetic payment simulator
│   ├── product.js            # Immutable server-side catalog definitions
│   └── validate.js           # Strict field & regex payload sanitization
├── public/
│   ├── index.html            # Editorial landing & product experience
│   ├── checkout.html         # Delivery details intake
│   ├── return.html           # Payment confirmation and status polling
│   ├── orders.html           # Stored receipts from localStorage tokens
│   └── css/styles.css        # Bespoke typography and responsive layout
├── scripts/
│   ├── setup.mjs             # Idempotent gateway clone and initialization
│   ├── dev-all.mjs           # Orchestrates store + gateway services
│   └── e2e.mjs               # Isolated end-to-end integration test runner
└── test/                     # Full test suite (65+ tests)
```

---

## 🚀 Quick Start

### Prerequisites
- **Node.js 24+** (Required for built-in `node:sqlite`)
- **Git**
- Open ports: `5000` (Store), `6100` (Payment API), `7000` (Checkout UI)

### 1. Clone & Setup
```bash
git clone https://github.com/FadnisW/Aura-Mug.git
cd Aura-Mug
```

Run the automated setup to configure the local gateway, databases, and cryptographic secrets:
```bash
npm run setup
# On Windows PowerShell: npm.cmd run setup
```

### 2. Launch Development Stack
```bash
npm run dev
# On Windows PowerShell: npm.cmd run dev
```

### 3. Open the Services
| Service | Address |
| :--- | :--- |
| **AURA Storefront** | [http://127.0.0.1:5000](http://127.0.0.1:5000) |
| **UPI-PG Payment API** | [http://127.0.0.1:6100](http://127.0.0.1:6100) |
| **Hosted Checkout Portal** | [http://127.0.0.1:7000](http://127.0.0.1:7000) |

---

## 🧪 Testing

AURA includes a comprehensive automated test suite covering unit math, schema migrations, and full cryptographic webhook lifecycles:

```bash
# Run unit, database, and webhook verification tests
npm test

# Run isolated End-to-End payment flow test (spins up ephemeral stack on :5180/:6180/:7180)
npm run test:e2e
```

---

## 📜 Disclaimer
*This repository is a demonstration of decentralized payment gateway architecture and local e-commerce ergonomics. Payments in the default demo mode are synthetic and use simulated bank-credit records for test purposes.*
