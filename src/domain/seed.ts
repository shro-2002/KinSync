import type { DatabaseSync } from 'node:sqlite';

/**
 * Deterministic synthetic demo data. All people are fictional; nothing here is real
 * patient data. Safe to call repeatedly (INSERT OR IGNORE on fixed ids).
 */
const SEED_TIME = '2026-10-01T00:00:00.000Z';

export const SEED = {
    households: [
        { id: 'hh_rao', name: 'Rao household (synthetic)', timezone: 'Asia/Kolkata' },
        { id: 'hh_chen', name: 'Chen household (synthetic)', timezone: 'America/Los_Angeles' }
    ],
    members: [
        { id: 'mem_ravi', household_id: 'hh_rao', display_name: 'Ravi', relationship: 'father', role: 'care_recipient', contact_label: 'Echo in living room (simulated)' },
        { id: 'mem_priya', household_id: 'hh_rao', display_name: 'Priya', relationship: 'daughter', role: 'coordinator', contact_label: 'Priya phone (simulated)' },
        { id: 'mem_arjun', household_id: 'hh_rao', display_name: 'Arjun', relationship: 'son', role: 'caregiver', contact_label: 'Arjun phone (simulated)' },
        { id: 'mem_meera', household_id: 'hh_rao', display_name: 'Meera', relationship: 'granddaughter', role: 'viewer', contact_label: 'Meera phone (simulated)' },
        { id: 'mem_lin', household_id: 'hh_chen', display_name: 'Lin', relationship: 'mother', role: 'care_recipient', contact_label: 'Echo in kitchen (simulated)' },
        { id: 'mem_wei', household_id: 'hh_chen', display_name: 'Wei', relationship: 'son', role: 'coordinator', contact_label: 'Wei phone (simulated)' }
    ],
    medicationSchedules: [
        { id: 'med_ravi_morning', household_id: 'hh_rao', member_id: 'mem_ravi', label: 'Morning medicines (as entered by Priya)', times_of_day: ['08:00'], entered_by_member_id: 'mem_priya' },
        { id: 'med_ravi_evening', household_id: 'hh_rao', member_id: 'mem_ravi', label: 'Evening medicines (as entered by Priya)', times_of_day: ['20:00'], entered_by_member_id: 'mem_priya' },
        { id: 'med_lin_morning', household_id: 'hh_chen', member_id: 'mem_lin', label: 'Morning medicines (as entered by Wei)', times_of_day: ['09:00'], entered_by_member_id: 'mem_wei' }
    ],
    // weekday: 0 = Sunday ... 6 = Saturday, in the household's time zone
    duty: [
        ...[1, 2, 3].map(weekday => ({ household_id: 'hh_rao', member_id: 'mem_priya', weekday })),
        ...[0, 4, 5, 6].map(weekday => ({ household_id: 'hh_rao', member_id: 'mem_arjun', weekday })),
        ...[0, 1, 2, 3, 4, 5, 6].map(weekday => ({ household_id: 'hh_chen', member_id: 'mem_wei', weekday }))
    ]
} as const;

export function seedDemoData(db: DatabaseSync): void {
    db.exec('BEGIN IMMEDIATE');
    try {
        const household = db.prepare('INSERT OR IGNORE INTO households (id, name, timezone, created_at) VALUES (?, ?, ?, ?)');
        for (const h of SEED.households) household.run(h.id, h.name, h.timezone, SEED_TIME);

        const member = db.prepare(
            'INSERT OR IGNORE INTO members (id, household_id, display_name, relationship, role, contact_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        for (const m of SEED.members) member.run(m.id, m.household_id, m.display_name, m.relationship, m.role, m.contact_label, SEED_TIME);

        const schedule = db.prepare(
            'INSERT OR IGNORE INTO medication_schedules (id, household_id, member_id, label, times_of_day, entered_by_member_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        for (const s of SEED.medicationSchedules) {
            schedule.run(s.id, s.household_id, s.member_id, s.label, JSON.stringify(s.times_of_day), s.entered_by_member_id, SEED_TIME);
        }

        const duty = db.prepare('INSERT OR IGNORE INTO duty_assignments (id, household_id, member_id, weekday) VALUES (?, ?, ?, ?)');
        for (const d of SEED.duty) duty.run(`duty_${d.household_id}_${d.weekday}`, d.household_id, d.member_id, d.weekday);

        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        throw new Error('Seeding demo data failed', { cause: err });
    }
}

export function isEmpty(db: DatabaseSync): boolean {
    return (db.prepare('SELECT COUNT(*) AS n FROM households').get() as { n: number }).n === 0;
}
