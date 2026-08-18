# NanoClaw Security Model

> The canonical, continuously-verified version of this model lives at
> [docs.nanoclaw.dev/concepts/security](https://docs.nanoclaw.dev/concepts/security).
> This in-repo copy can drift; if the two disagree, verify against
> `src/container-runner.ts` (`buildMounts`).

## Trust Model

Privilege is **user-level**, persisted in the `user_roles` table (owner /
admin, global or scoped to an agent group) plus `agent_group_members` (the
unprivileged access gate).

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Owners / admins (`user_roles`) | Trusted | Hold owner/admin roles; gate admin commands and approve credentialed actions |
| Group members (`agent_group_members`) | Access-gated | Membership grants access to an agent group, but their messages are still untrusted input |
| Unregistered senders | Untrusted | Subject to each messaging group's `unknown_sender_policy` |
| Agent containers | Sandboxed | Long-lived per-session container; isolated by mounts, non-root, no host reach |
| Incoming messages | User input | Potential prompt injection regardless of who sent them |

## Security Boundaries

### 1. Container Isolation (Primary Boundary)

Agents execute in containers (Docker), providing:
- **Process isolation** — container processes cannot affect the host
- **Filesystem isolation** — only explicitly mounted directories are visible
- **Non-root execution** — runs as an unprivileged user (`node`, uid 1000, or the host uid remapped in)
- **Per-session containers** — one long-lived container per session polls that session's DBs and handles many messages, then is torn down (`--rm`) when the session goes idle.

This is the primary security boundary. Rather than relying on application-level
permission checks, the attack surface is limited by what's mounted.

### 2. Mount Security

`buildMounts` (`src/container-runner.ts`) composes a fixed set of mounts per
spawn. For the default (Claude) provider these are:

| Container path | Host source | Mode | Purpose |
|---|---|---|---|
| `/workspace` | `data/v2-sessions/<group>/<session>/` | RW | Session folder — `inbound.db`, `outbound.db`, `outbox/`, `.claude/` |
| `/workspace/agent` | `groups/<folder>/` | RW | Agent working files, standing instructions, and shared memory tree |
| `/workspace/agent/container.json` | group `container.json` | RO | Container config — readable, not writable |
| `/workspace/agent/CLAUDE.md` | composed `CLAUDE.md` | RO | Regenerated every spawn; agent edits would be clobbered |
| `/workspace/agent/.claude-fragments` | group `.claude-fragments/` | RO | Composer skill/MCP fragments |
| `/app/CLAUDE.md` | `container/CLAUDE.md` | RO | Shared base doc imported by the composed entry point |
| `/home/node/.claude` | `data/v2-sessions/<group>/.claude-shared/` | RW | Claude state, settings, skill symlinks |
| `/app/src` | `container/agent-runner/src/` | RO | Shared agent-runner source (same for all groups) |
| `/app/skills` | `container/skills/` | RO | Shared container skills |
| `/workspace/extra/<name>` | allowlisted host dir | RO (RW only if allowed) | Operator-configured additional mounts |

The config mounts (`container.json`, `CLAUDE.md`, `.claude-fragments`) are
**nested read-only mounts on top of the read-write group dir** — the agent can
read its config but cannot modify it. The project root is **never mounted**: the
container only ever sees the paths above plus any provider-contributed mounts
(e.g. an OpenCode XDG dir). Host application source (`src/`, `dist/`,
`package.json`) is not reachable.

Shared memory content is read only by the provider's SessionStart hook inside
the container. Host-side project-document composers emit pointers but never
open `memory/index.md` or linked agent-controlled files. A memory symlink can
therefore reach only paths already visible inside that container, not arbitrary
host files.

**Additional-mount allowlist** — extra mounts from a group's container config
are validated against an allowlist at `~/.config/nanoclaw/mount-allowlist.json`,
which is:
- Outside the project root
- Never mounted into containers
- Not modifiable by agents

Its schema:

```json
{
  "allowedRoots": [
    { "path": "~/projects", "allowReadWrite": true, "description": "Dev projects" },
    { "path": "~/Documents/work", "allowReadWrite": false, "description": "Read-only" }
  ],
  "blockedPatterns": ["password", "secret", "token"]
}
```

**Default blocked patterns** (merged with any in the file):
```
.ssh, .gnupg, .gpg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, .pypirc, id_rsa, id_ed25519,
private_key, .secret
```

**Enforcement** (`src/modules/mount-security/index.ts`):
- **No allowlist file ⇒ every additional mount is blocked** — the fixed mounts above are unaffected, but nothing extra is granted until the operator creates the file.
- Symlinks are resolved to their real path (`realpathSync`) before any check, defeating traversal via symlink.
- The real path is rejected if it matches a blocked pattern, and rejected unless it sits under one of `allowedRoots`.
- The container path is validated: relative, non-empty, no `..`, no leading `/`, no `:` (blocks Docker `-v` option injection). It is mounted under `/workspace/extra/`.
- **Read-write is granted only when the mount requests it (`readonly: false`) *and* the matched root has `allowReadWrite: true`.** Otherwise the mount is forced read-only.

### 3. Session Isolation

Per-session state lives under `data/v2-sessions/<agent-group>/<session>/`
(`inbound.db`, `outbound.db`, `outbox/`, `.claude/`). Claude state
(`.claude-shared`) and the working folder are scoped to the agent group, so:
- Different agent groups cannot see each other's conversation history or files.
- A group's sessions share that group's memory but keep separate message DBs.

This prevents cross-group information disclosure.

### 4. Credential Isolation (OneCLI Agent Vault)

Real API credentials **never enter containers**. NanoClaw uses [OneCLI's Agent Vault](https://github.com/onecli/onecli) to proxy outbound requests and inject credentials at the gateway level.

**How it works:**
1. Credentials are registered once with `onecli secrets create`, stored and managed by OneCLI
2. When NanoClaw spawns a container, it calls `applyContainerConfig()` to route outbound HTTPS through the OneCLI gateway
3. The gateway matches requests by host and path, injects the real credential, and forwards
4. Agents cannot discover real credentials — not in environment, stdin, files, or `/proc`

**Per-agent policies:**
Each NanoClaw group gets its own OneCLI agent identity. This allows different credential policies per group (e.g. your sales agent vs. support agent). OneCLI supports rate limits, and time-bound access and approval flows are on the roadmap.

**Never on the container filesystem:**
- The project root and `.env` — never mounted; the container only receives the paths in the mount table above.
- The mount allowlist — external (`~/.config/nanoclaw/…`), never mounted.
- Real credentials — injected per request by the OneCLI gateway, never written into any mount.

### 5. Egress Lockdown (Forced Proxy)

The `HTTPS_PROXY` env var only redirects *proxy-aware* clients — a tool that
ignores it (or a raw socket) could reach the internet directly and bypass
credential injection, approvals, and audit. Egress lockdown closes that hole at
the network layer.

**How it works:** agents are placed on a Docker `--internal` network
(`nanoclaw-egress`) that has **no route to the internet**. The OneCLI gateway
container is attached to that network, aliased as `host.docker.internal`, so the
injected proxy URL (`…@host.docker.internal:10255`) resolves to the gateway
*container-to-container*. The gateway is therefore the **only reachable hop** —
anything else has nowhere to go. The agent is non-root with no `NET_ADMIN`, so
it cannot undo this. Identical mechanism on macOS and Linux (no host firewall,
no `host-gateway` route).

- **Self-healing:** the gateway is re-attached to the network at every spawn and
  on each host-sweep tick, so an out-of-band detach (e.g. `docker compose up` on
  the OneCLI stack — its compose lives in `~/.onecli`, not this repo) recovers
  automatically.
- **Fail-fast:** if lockdown is on but the network can't be created or the
  gateway can't be attached (e.g. a non-standard gateway container name, or the
  gateway isn't running), nanoclaw **refuses to spawn the agent** and surfaces a
  clear error — it never silently falls back to open egress. Fix the cause (or
  set `NANOCLAW_EGRESS_LOCKDOWN=false`) and retry. The host-sweep re-heal is the
  exception: a heal failure there is logged but not fatal, since already-running
  agents stay on the internal net (no leak) until the gateway returns.

**Default: egress is open.** Lockdown is **off** unless you opt in; by default
the agent reaches the OneCLI gateway over the host-gateway path and outbound
traffic is not confined to the internal network.

**Configuration:**

| Env | Default | Meaning |
| --- | --- | --- |
| `NANOCLAW_EGRESS_LOCKDOWN` | `false` | Set `true` to opt in (otherwise the host-gateway path is used). |
| `NANOCLAW_EGRESS_NETWORK` | `nanoclaw-egress` | Network name. |
| `ONECLI_GATEWAY_CONTAINER` | `onecli` | Gateway container to attach. |

These variables are read from the **host process** environment (the service's
environment / `.env`), not from inside the container. The agent container is
started with only `TZ` and any provider-declared variables — host environment
variables, including secrets, are never forwarded into the agent.

**⚠ Behavior when enabled:** with lockdown on, agents have **no direct
internet** — all traffic must go through OneCLI. Proxy-aware clients (npm, pnpm,
pip, curl, node/bun with the proxy env) are unaffected. Any workflow that relies
on a **non-proxy-aware** tool reaching the internet directly will fail by design.
Lockdown is **off by default**; opt in with `NANOCLAW_EGRESS_LOCKDOWN=true`.

### 6. MCP Tool Access Control (Read-Only Enforcement)

Not every third-party API a group's MCP servers talk to can be scoped
read-only at the credential level — some vendors issue one API key/secret
with full read+write access and no narrower role to request. For those,
NanoClaw enforces the read/write split itself instead of relying on the
vendor.

`McpServerConfig` (`src/container-config.ts`) carries an optional
`deniedTools?: string[]` — bare tool names (no `mcp__<server>__` prefix) to
block on that server. The provider (`container/agent-runner/src/providers/
claude.ts`) turns each into a `mcp__<server>__<tool>` entry in the CLI's
`disallowedTools` list.

**This must be a denylist, not an allowlist.** Tested directly against the
`claude` CLI: a narrow `--allowedTools` list naming only the tools meant to
be permitted does **not** hide a connected MCP server's other tools — a
model asked to enumerate a server's tools under a restrictive `allowedTools`
still saw every tool, permitted or not, and would call a "restricted" one if
not for its own judgment. Only `--disallowedTools` with exact tool names
genuinely removes a tool from what the model can see or call. `deniedTools`
is implemented on that basis — an allowlist-shaped field would look correct
and enforce nothing.

**Setting it:**
- New groups: add `deniedTools: [...]` to the server's entry in
  `DEFAULT_MCP_SERVERS` (`src/config.ts`).
- Existing groups: `ncl groups config add-mcp-server --id <group> --name
  <server> --command <cmd> --env <json> --denied-tools '["tool1","tool2"]'`
  (re-supplying `command`/`env` too — this replaces the whole server entry,
  it does not merge), then `ncl groups restart --id <group>`.

**Agents cannot grant themselves a blocked tool back.** No self-mod tool
(`add_mcp_server`, `container/agent-runner/src/mcp-tools/self-mod.ts`)
exposes `deniedTools` as a settable param — the same deliberate gap as
`cwd`/`pluginRoot`. Only the host-side `ncl` CLI (operator) or
`DEFAULT_MCP_SERVERS` (install config) can set it.

**Currently configured in this install** (as of 2026-08-18) — servers whose
own credentials have no read-only scope:

| Server | Blocked tools |
| --- | --- |
| `ninjaone` | `ninjaone_devices_reboot`, `ninjaone_organizations_create`, `ninjaone_alerts_reset`, `ninjaone_alerts_reset_all`, `ninjaone_tickets_create`, `ninjaone_tickets_update`, `ninjaone_tickets_add_comment` |
| `itglue` | `create_location`, `update_location`, `create_document`, `create_document_section`, `update_document_section`, `delete_document_section`, `publish_document`, `archive_document`, `unarchive_document` |
| `cipp` | `cipp_create_user`, `cipp_edit_user`, `cipp_disable_user`, `cipp_reset_password`, `cipp_reset_mfa`, `cipp_revoke_sessions`, `cipp_offboard_user`, `cipp_create_group`, `cipp_set_out_of_office`, `cipp_set_email_forwarding`, `cipp_create_standard_template`, `cipp_delete_standard_template`, `cipp_run_standards_check`, `cipp_add_scheduled_item` |
| `uptime-kuma` | `createMonitor`, `updateMonitor`, `deleteMonitor`, `addNotification`, `updateNotification`, `deleteNotification`, `addTag`, `deleteTag`, `createMaintenance`, `addDockerHost`, `updateDockerHost`, `deleteDockerHost`, `createStatusPage`, `updateStatusPage`, `deleteStatusPage`, `pauseMonitor`, `resumeMonitor` |
| `autotask` | All 41 `autotask_create_*`/`autotask_update_*`/`autotask_delete_*` tools, plus `autotask_execute_tool` and `autotask_raw_request` — see below |
| `cove` | `call`, `import` — see below |
| `ruckus` | `vsz_create_zone`, `vsz_update_zone`, `vsz_delete_zone`, `vsz_update_ap`, `vsz_delete_ap`, `vsz_reboot_ap`, `vsz_create_wlan`, `vsz_update_wlan`, `vsz_delete_wlan`, `vsz_enable_disable_wlan`, `vsz_disconnect_client`, `vsz_acknowledge_alarm`, `vsz_clear_alarm`, `vsz_create_domain`, `vsz_block_client`, `vsz_unblock_client`, `vsz_mark_rogue` |

Not restricted: `m365mail` and `bookstack` (already read-only at the
source — `--enabled-tools` / `BOOKSTACK_ENABLE_WRITE=false` on the
underlying package; for bookstack verified directly by diffing `tools/list`
with the flag on vs off, 38 tools vs 20, not just trusting the README),
`learn`, `sentinelone`, and `wazuh` (entirely read/query tools by design,
nothing to block), `unifi` (the `cloud-ea` tool set registered is
read/reporting-only — no device-control tools exist in that mode), and
`veeam` (a single Q&A tool with no CRUD surface at all), and `sophos`
(a from-scratch, purpose-built MCP server — every mutating Sophos
Central endpoint, e.g. isolate endpoint, release quarantine, reboot
firewall, mailbox CRUD, was simply never implemented, rather than
implemented and then denied).

`itglue`'s `get_password`/`search_passwords` are intentionally **not**
blocked — they read a value rather than mutate anything, so they're a
data-sensitivity question, not a write-access one. Revisit if that's a
concern for this install.

**`autotask`'s deny-list has to cover more than the obvious write tools.**
Its 101-tool surface includes `autotask_execute_tool` ("Execute any Autotask
tool by name") and `autotask_raw_request` (arbitrary GET/POST/PATCH/PUT/DELETE
against any Autotask REST path). Both are **blocked outright**, not
selectively: `deniedTools` matches the literal MCP tool name the model
calls (`mcp__autotask__autotask_execute_tool`), not a tool name passed as
a string *argument* to that call — so blocking `autotask_delete_ticket_charge`
alone would do nothing to stop `autotask_execute_tool({toolName:
"autotask_delete_ticket_charge", ...})` from reaching the same handler.
`autotask_router` stays allowed — verified in source
(`src/handlers/tool.handler.ts`) that it only returns a suggested-tool-name
object and never itself dispatches to a handler.

**`cove`'s API user has no read-only role option**, so the same
generic-escape-hatch reasoning applies: `call` invokes any of Cove's 251
JSON-RPC methods by name (the vendor's own README already classifies this as
"Human-in-the-loop; preview with `--dry-run`" for that reason) and `import`
issues a live POST per JSONL record — a bulk-write path the README's safety
table doesn't even mention, found only by reading the tool's actual
description. The other 31 tools are enumerate/get/list against Cove's
management API (which doesn't cover restores or file browsing at all) or
local-only writes to the SQLite mirror (`sync`, `snapshot`,
`workflow_archive`) that never touch the tenant — left unrestricted.

## Resource Limits

Per-container CPU and memory caps are **opt-in and unset by default** — a runaway
agent is not throttled unless the operator configures a limit:

| Env | Default | Meaning |
| --- | --- | --- |
| `CONTAINER_CPU_LIMIT` | *(empty — unbounded)* | Passed to `--cpus` when set (e.g. `2`). |
| `CONTAINER_MEMORY_LIMIT` | *(empty — unbounded)* | Passed to `--memory` when set (e.g. `8g`). |

Only `--memory` is a container-level cap; whether it's a *hard* cap depends on
the host having no swap (a deployment concern). On a swapless host a runaway is
OOM-killed at the limit.

## Security Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                             │
│  Incoming Messages (potentially malicious)                         │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Trigger check, input escaping
┌──────────────────────────────────────────────────────────────────┐
│                     HOST PROCESS (TRUSTED)                        │
│  • Message routing                                                │
│  • Role / access checks (user_roles, agent_group_members)        │
│  • Mount validation (external allowlist)                          │
│  • Container lifecycle                                            │
│  • OneCLI Agent Vault (injects credentials, enforces policies)   │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Explicit mounts only, no secrets
┌──────────────────────────────────────────────────────────────────┐
│                CONTAINER (ISOLATED/SANDBOXED)                     │
│  • Agent execution                                                │
│  • Bash commands (sandboxed)                                      │
│  • File operations (limited to mounts)                            │
│  • API calls routed through OneCLI Agent Vault                   │
│  • No real credentials in environment or filesystem              │
└──────────────────────────────────────────────────────────────────┘
```

## Supply Chain Security (pnpm)

NanoClaw uses pnpm with two supply chain defenses configured in `pnpm-workspace.yaml`:

### Minimum Release Age

`minimumReleaseAge: 4320` (3 days). pnpm will refuse to resolve any package version published less than 3 days ago. This defends against typosquatting and compromised maintainer accounts — most malicious publishes are detected and pulled within 72 hours.

**Excluding a package from the release age gate** (`minimumReleaseAgeExclude`):

This should be rare. When a zero-day fix or critical dependency requires an immediate update:

1. The exclusion must be reviewed and approved by a human maintainer
2. The entry must pin the **exact version** being excluded — never a range or wildcard
   ```yaml
   minimumReleaseAgeExclude:
     some-package: "1.2.3"  # Approved by @user, 2026-04-14 — CVE-XXXX-YYYY fix
   ```
3. The exclusion should be removed once the version ages past the threshold (i.e. after 3 days)
4. Automated agents (Claude, CI bots) must never add exclusions without human sign-off

### Build Script Allowlist

`onlyBuiltDependencies` restricts which packages can execute install/postinstall scripts. Only packages on this list are permitted to run build scripts during `pnpm install`. Currently allowed:

- `better-sqlite3` — compiles native SQLite bindings
- `esbuild` — downloads platform-specific binary
- `protobufjs` — generates protobuf bindings (used by Baileys/libsignal)
- `sharp` — downloads platform-specific image processing binary

Adding a package to this list requires human approval — build scripts execute arbitrary code with the installing user's permissions.

### `.npmrc` Safety Net

The `.npmrc` file contains `minReleaseAge=3d` as a fallback. The authoritative setting is in `pnpm-workspace.yaml`, but `.npmrc` provides defense-in-depth if npm is ever invoked directly (e.g. by a tool that doesn't respect pnpm).
