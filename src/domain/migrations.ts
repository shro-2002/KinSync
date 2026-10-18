import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Forward-only migrations tracked in PRAGMA user_version. Each runs in its own transaction.
 * A PoC-0 database (user_version 0 with a legacy `events` table) upgrades in place; the
 * legacy table is left untouched and unused.
 */
const MIGRATIONS: ReadonlyArray<{ version: number; name: string; sql: string }> = [
    {
        version: 1,
        name: 'domain_v1',
        sql: `
CREATE TABLE households (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    timezone TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE members (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id),
    display_name TEXT NOT NULL,
    relationship TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('care_recipient', 'coordinator', 'caregiver', 'viewer')),
    contact_label TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_members_household_id ON members(household_id);

-- Reference data typed in by family members. Deliberately has no dose/strength column:
-- CareLoop stores labels and times only and never recommends medication.
CREATE TABLE medication_schedules (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id),
    member_id TEXT NOT NULL REFERENCES members(id),
    label TEXT NOT NULL,
    times_of_day TEXT NOT NULL,
    entered_by_member_id TEXT NOT NULL REFERENCES members(id),
    created_at TEXT NOT NULL
);
CREATE INDEX idx_medication_schedules_household_id ON medication_schedules(household_id);

CREATE TABLE care_events (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id),
    subject_member_id TEXT NOT NULL REFERENCES members(id),
    reported_by_member_id TEXT NOT NULL REFERENCES members(id),
    kind TEXT NOT NULL CHECK (kind IN ('medication', 'meal', 'symptom', 'mood', 'appointment', 'note')),
    note TEXT NOT NULL,
    medication_schedule_id TEXT REFERENCES medication_schedules(id),
    occurred_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL
);
CREATE INDEX idx_care_events_household_id_occurred_at ON care_events(household_id, occurred_at);

CREATE TABLE duty_assignments (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id),
    member_id TEXT NOT NULL REFERENCES members(id),
    weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
    UNIQUE (household_id, weekday)
);

CREATE TABLE appointment_requests (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id),
    subject_member_id TEXT NOT NULL REFERENCES members(id),
    requested_by_member_id TEXT NOT NULL REFERENCES members(id),
    reason_as_reported TEXT NOT NULL,
    preferred_window TEXT NOT NULL CHECK (preferred_window IN ('asap_non_urgent', 'this_week', 'next_week')),
    provider_label TEXT,
    related_event_id TEXT REFERENCES care_events(id),
    status TEXT NOT NULL CHECK (status IN ('prepared', 'handed_off')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_appointment_requests_household_id ON appointment_requests(household_id);

CREATE TABLE notification_drafts (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id),
    recipient_member_id TEXT NOT NULL REFERENCES members(id),
    drafted_by_member_id TEXT NOT NULL REFERENCES members(id),
    appointment_request_id TEXT REFERENCES appointment_requests(id),
    related_event_id TEXT REFERENCES care_events(id),
    channel TEXT NOT NULL CHECK (channel = 'simulated'),
    body TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending_approval', 'approved', 'rejected')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_notification_drafts_household_id ON notification_drafts(household_id);

CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id),
    action_type TEXT NOT NULL CHECK (action_type = 'send_notification'),
    target_id TEXT NOT NULL UNIQUE,
    requested_by_member_id TEXT NOT NULL REFERENCES members(id),
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
    decided_by_member_id TEXT REFERENCES members(id),
    decision_reason TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
);
CREATE INDEX idx_approvals_household_id_status ON approvals(household_id, status);

-- A notification can be "sent" at most once; nothing here ever leaves the machine.
CREATE TABLE simulated_outbox (
    id TEXT PRIMARY KEY,
    notification_id TEXT NOT NULL UNIQUE REFERENCES notification_drafts(id),
    household_id TEXT NOT NULL REFERENCES households(id),
    recipient_member_id TEXT NOT NULL REFERENCES members(id),
    body TEXT NOT NULL,
    delivery TEXT NOT NULL CHECK (delivery = 'simulated_not_sent'),
    created_at TEXT NOT NULL
);

CREATE TABLE idempotency_keys (
    actor_member_id TEXT NOT NULL REFERENCES members(id),
    tool TEXT NOT NULL,
    key TEXT NOT NULL,
    household_id TEXT NOT NULL REFERENCES households(id),
    request_hash TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (actor_member_id, tool, key)
);

CREATE TABLE audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor_member_id TEXT,
    household_id TEXT,
    action TEXT NOT NULL,
    target_id TEXT,
    outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'replayed', 'deduplicated', 'denied', 'invalid', 'conflict', 'error')),
    detail TEXT
);
CREATE INDEX idx_audit_events_household_id ON audit_events(household_id);
`
    },
    {
        // KinSync care handoff: additive only. Current state lives in handoffs; every move is a row in handoff_transitions.
        version: 2,
        name: 'care_handoff_v1',
        sql: `
CREATE TABLE handoffs (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id),
    requested_by_member_id TEXT NOT NULL REFERENCES members(id),
    from_member_id TEXT NOT NULL REFERENCES members(id),
    to_member_id TEXT NOT NULL REFERENCES members(id),
    task_as_reported TEXT NOT NULL,
    recipient_basis TEXT NOT NULL CHECK (recipient_basis IN ('named', 'only_eligible_member')),
    status TEXT NOT NULL CHECK (status IN ('PENDING_APPROVAL', 'PENDING_ACCEPTANCE', 'COMPLETED', 'REJECTED', 'DECLINED')),
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (from_member_id != to_member_id)
);
CREATE INDEX idx_handoffs_household_id_status ON handoffs(household_id, status);

CREATE TABLE handoff_transitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    handoff_id TEXT NOT NULL REFERENCES handoffs(id),
    household_id TEXT NOT NULL REFERENCES households(id),
    event TEXT NOT NULL CHECK (event IN ('propose', 'approve', 'reject', 'accept', 'decline')),
    from_status TEXT,
    to_status TEXT NOT NULL,
    actor_member_id TEXT NOT NULL REFERENCES members(id),
    actor_mode TEXT NOT NULL CHECK (actor_mode IN ('session', 'simulated')),
    simulated_by_member_id TEXT REFERENCES members(id),
    reason TEXT,
    at TEXT NOT NULL
);
CREATE INDEX idx_handoff_transitions_handoff_id ON handoff_transitions(handoff_id);
`
    }
];

export const SCHEMA_VERSION = MIGRATIONS.at(-1)!.version;

export function openDatabase(path: string): DatabaseSync {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    migrate(db);
    return db;
}

export function migrate(db: DatabaseSync): number {
    let current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    for (const m of MIGRATIONS) {
        if (m.version <= current) continue;
        db.exec('BEGIN IMMEDIATE');
        try {
            db.exec(m.sql);
            db.exec(`PRAGMA user_version = ${m.version}`);
            db.exec('COMMIT');
            current = m.version;
        } catch (err) {
            db.exec('ROLLBACK');
            throw new Error(`Migration ${m.version} (${m.name}) failed`, { cause: err });
        }
    }
    return current;
}
