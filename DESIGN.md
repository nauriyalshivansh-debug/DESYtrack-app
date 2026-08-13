# DESYtrack — Database & Application Design

**Domain:** tracking physical laboratory / material samples through their lifecycle, with
controlled collaboration between an internal team and external industry partners.
**Status:** implemented (this design corresponds 1:1 to the running application).

---

## 1. Design goals and the constraints they impose

| Goal | Design consequence |
|------|--------------------|
| Every sample is uniquely identifiable and auditable | Human-readable accession code + append-only event log |
| The status lifecycle must be *enforced*, not merely recorded | Statuses and legal transitions stored as data; API validates every change against the transition graph |
| External partners collaborate but must not see everything | Two layers: coarse **role** (RBAC) + fine **row-level grants** (`sample_access`) |
| Chain of custody must be tamper-evident | Events are insert-only; no update/delete path is exposed |
| The workflow will change over time | Statuses/transitions are reference data, editable without code changes |

---

## 2. Entity–relationship model

```
users ──< samples >── statuses
  │         │  │  └────────── status_transitions (self-join on statuses)
  │         │  ├──< custody_events        (append-only audit trail)
  │         │  ├──< tests                  (analyses & results)
  │         │  ├──< comments               (shared | internal)
  │         │  └──< sample_access >── users (row-level partner sharing)
  └── custodian / created_by / actor / author / performer  (role of a user on a row)
```

**Cardinalities**

- A **user** creates many samples, is custodian of many samples, and is the actor on many events.
- A **sample** has exactly one current status, one current custodian, and many events, tests, and comments.
- **`sample_access`** is the associative entity resolving the many-to-many between partner users and the samples shared with them.
- **`status_transitions`** is a reflexive many-to-many on `statuses` — the adjacency list of a directed graph.

---

## 3. Tables (authoritative definitions in `backend/schema.sql`)

**`users`** — identity + global capability.
`role ∈ {admin, member, partner}`; `organization` is set for partners (their company).
Passwords stored only as bcrypt hashes.

**`statuses`** — reference data: `code` (PK), `label`, `sort_order`, `is_terminal`.

**`status_transitions`** — `(from_status, to_status)` composite PK; each row is one legal edge.

**`samples`** — the core entity. Descriptive fields (name, description, material_type,
batch_lot, origin, quantity+unit, storage_location, hazard_class), a `status` FK, a
`custodian_id`, provenance (`created_by`, `received_at`), and `created_at`/`updated_at`.
Indexed on `status`, `custodian_id`, and `material_type` — the three filter axes.

**`custody_events`** — **append-only** audit trail. `event_type ∈ {created, status_change,
transfer, test_logged, note, edit}`, `from_value`/`to_value` (for status/custody changes),
`note`, `actor_id`, `created_at`. This is the chain of custody.

**`tests`** — `test_type`, `method` (SOP/standard, e.g. `ASTM D638`), `result_value`
(text, to hold numbers, ranges, or verdicts), `result_unit`, `outcome ∈ {pass, fail,
inconclusive, pending}`, performer, timestamps.

**`comments`** — `body`, `author_id`, and `visibility ∈ {shared, internal}`. Internal
comments are invisible to partner accounts.

**`sample_access`** — row-level grant: `(sample_id, user_id)` composite PK, `can_edit`
flag (partners default read-only), `granted_by`. **A partner sees a sample iff a grant row exists.**

---

## 4. Status workflow (the transition graph)

```
received → registered → in_testing ⇄ on_hold
                            │
                            ▼
                        completed → shared ⇄ completed
                            │   \        \
                            │    → archived → disposed
                            └──────────────→ disposed
```

Terminal states: `archived`, `disposed`. Any change not present as an edge in
`status_transitions` is rejected with `400 Transition X → Y not allowed`. Because the
graph is data, extending the workflow is an `INSERT`, not a deployment.

---

## 5. Access-control model (defence in depth)

**Layer 1 — Role (coarse).** Middleware gates whole endpoints: only `admin`/`member`
may create/edit samples, change status, or log tests; only `admin` may create users or
manage grants.

**Layer 2 — Row-level scoping (fine).** For any partner request the query is
constrained by an inner join to `sample_access`. List, detail, dashboard stats, and
comment visibility are all filtered the same way, so there is **no endpoint through which
a partner can enumerate or read an unshared sample** — an unshared sample returns `404`,
not `403`, so its very existence is not disclosed.

**Layer 3 — Field-level.** `comments.visibility = 'internal'` are stripped from partner
responses at the query level; partners may only ever write `shared` comments even if they
forge the payload.

These three layers were verified with an automated boundary test: a partner is limited to
shared samples, receives `404` on others, cannot see internal comments, is blocked (`403`)
from mutating data, yet can post shared comments.

---

## 6. Auditability

Mutations write a `custody_events` row in the same request path as the change, capturing
*who*, *what*, *from → to*, and *when*. No API route updates or deletes an event, so the
trail is append-only by construction — the property auditors and chain-of-custody
requirements depend on.

---

## 7. Extension points (deliberately left open)

- **File attachments** — a `sample_files` table (blob store key + metadata) hangs off `samples`.
- **Notifications** — the event log is already the natural source for a digest/webhook feed.
- **Custom fields** — a key/value `sample_attributes` table if per-material-type fields are needed.
- **PostgreSQL** — schema is portable; see README for the handful of dialect deltas.
```
