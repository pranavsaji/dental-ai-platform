import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, count, desc, eq, gte, ilike, inArray, lt, lte, notInArray, or, sql, sum } from "drizzle-orm";
import {
  appointments, auditLog, claims, commLogs, huddleDigests, insPlans, locations,
  operatories, patPlans, patients, preauths, procedureCodes, procedures,
  providers, recalls
} from "@dental/db";
import { DB, type Db } from "../db";
import type { SessionUser } from "../auth/auth";
import { assertCan, can } from "../auth/roles";

// All portal reads are tenancy-scoped here: orgId always comes from the JWT,
// and a location-restricted user cannot query another location. Provider-role
// users carry a providerSourceId (their PMS ProvNum) that additionally scopes
// schedule/patient reads to their own appointments and patients.

/** The PMS provider id a doctor's reads are scoped to, or null = unscoped.
 *  Fails closed: an unlinked provider account gets a 403, not the whole
 *  location's PHI (admin invite/update enforces the link, so this only fires
 *  for stale sessions or hand-edited rows). */
export function providerScopeOf(user: SessionUser): number | null {
  if (user.role !== "provider") return null;
  if (user.providerSourceId == null) {
    throw new ForbiddenException(
      "Provider account is not linked to a PMS provider record — sign out and back in, or ask an admin"
    );
  }
  return user.providerSourceId;
}

@Injectable()
export class PortalService {
  constructor(@Inject(DB) private db: Db) {}

  async resolveLocation(user: SessionUser, locationId?: number) {
    const rows = await this.db.select().from(locations).where(eq(locations.orgId, user.orgId));
    if (user.locationId != null) {
      const own = rows.find((l) => l.id === user.locationId);
      if (!own) throw new ForbiddenException("No location access");
      if (locationId != null && locationId !== own.id) {
        throw new ForbiddenException("Not allowed for this location");
      }
      return own;
    }
    const target = locationId != null ? rows.find((l) => l.id === locationId) : rows[0];
    if (!target) throw new NotFoundException("Location not found");
    return target;
  }

  async listLocations(user: SessionUser) {
    // Explicit columns: integration provenance for the header badge (A1),
    // and never ship edgeApiKey to the browser.
    const rows = await this.db.select({
      id: locations.id,
      key: locations.key,
      name: locations.name,
      timezone: locations.timezone,
      integrationMode: locations.integrationMode,
      integrationStatus: locations.integrationStatus,
      lastHeartbeatAt: locations.lastHeartbeatAt
    }).from(locations).where(eq(locations.orgId, user.orgId));
    return user.locationId != null ? rows.filter((l) => l.id === user.locationId) : rows;
  }

  async overview(user: SessionUser, locationId?: number) {
    const loc = await this.resolveLocation(user, locationId);
    const now = new Date();
    const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(now); dayEnd.setHours(23, 59, 59, 999);
    const weekAhead = new Date(now.getTime() + 7 * 86_400_000);
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
    const todayStr = now.toISOString().slice(0, 10);

    // A provider's overview counts only their own appointments and patients.
    const psid = providerScopeOf(user);
    const scope = psid != null
      ? and(eq(appointments.locationId, loc.id), eq(appointments.providerSourceId, psid))
      : eq(appointments.locationId, loc.id);
    const [todayAppts] = await this.db.select({ n: count() }).from(appointments)
      .where(and(scope, eq(appointments.status, "scheduled"), gte(appointments.startsAt, dayStart), lte(appointments.startsAt, dayEnd)));
    const [upcoming] = await this.db.select({ n: count() }).from(appointments)
      .where(and(scope, eq(appointments.status, "scheduled"), gte(appointments.startsAt, now), lte(appointments.startsAt, weekAhead)));
    const [brokenRecent] = await this.db.select({ n: count() }).from(appointments)
      .where(and(scope, eq(appointments.status, "broken"), gte(appointments.sourceStamp, weekAgo)));
    const [patientCount] = await this.db.select({ n: count() }).from(patients)
      .where(and(
        eq(patients.locationId, loc.id), eq(patients.status, "active"),
        psid != null ? eq(patients.primaryProviderSourceId, psid) : sql`true`
      ));
    const [overdueRecalls] = await this.db.select({ n: count() }).from(recalls)
      .where(and(eq(recalls.locationId, loc.id), eq(recalls.isDisabled, false), lt(recalls.dateDue, todayStr)));
    const [openClaims] = await this.db.select({ n: count(), fees: sum(claims.claimFee) }).from(claims)
      .where(and(eq(claims.locationId, loc.id), inArray(claims.status, ["sent", "waiting"])));

    // C5: value sitting in planned-but-unscheduled treatment — the top-ROI
    // tile. Patients with any future scheduled appointment don't count.
    const withUpcoming = this.db
      .select({ pat: appointments.patientSourceId })
      .from(appointments)
      .where(and(scope, eq(appointments.status, "scheduled"), sql`${appointments.startsAt} > now()`));
    const [unscheduled] = await this.db
      .select({ n: count(), fees: sum(procedures.fee) })
      .from(procedures)
      .where(and(
        eq(procedures.locationId, loc.id),
        eq(procedures.status, "planned"),
        notInArray(procedures.patientSourceId, withUpcoming)
      ));

    // Dollar figures are billing surface — counts stay visible to everyone,
    // amounts only to roles that can read the billing worklists.
    const money = can(user, "billing.read");
    return {
      location: { id: loc.id, key: loc.key, name: loc.name },
      todayScheduled: todayAppts.n,
      upcoming7d: upcoming.n,
      broken7d: brokenRecent.n,
      activePatients: patientCount.n,
      overdueRecalls: overdueRecalls.n,
      openClaims: openClaims.n,
      openClaimsValue: money ? Number(openClaims.fees ?? 0) : null,
      unscheduledTreatment: unscheduled.n,
      unscheduledTreatmentValue: money ? Number(unscheduled.fees ?? 0) : null
    };
  }

  // C1: the digest panel on Overview. Defaults to today (local calendar day,
  // matching how generateHuddleDigest stamps rows); history by date.
  async huddleDigest(locationId: number, date?: string) {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const target = date ?? `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const [row] = await this.db.select().from(huddleDigests)
      .where(and(eq(huddleDigests.locationId, locationId), eq(huddleDigests.date, target)));
    return row ?? null;
  }

  async schedule(user: SessionUser, locationId: number | undefined, dateStr: string | undefined) {
    const loc = await this.resolveLocation(user, locationId);
    const day = dateStr ? new Date(`${dateStr}T00:00:00`) : new Date();
    day.setHours(0, 0, 0, 0);
    const dayEnd = new Date(day); dayEnd.setHours(23, 59, 59, 999);

    const rows = await this.db
      .select({
        sourceId: appointments.sourceId,
        status: appointments.status,
        startsAt: appointments.startsAt,
        minutes: appointments.minutes,
        confirmed: appointments.confirmed,
        procDescript: appointments.procDescript,
        note: appointments.note,
        noShowRisk: appointments.noShowRisk,
        noShowFactors: appointments.noShowFactors,
        operatorySourceId: appointments.operatorySourceId,
        patientSourceId: appointments.patientSourceId,
        patientFirst: patients.firstName,
        patientLast: patients.lastName,
        providerAbbr: providers.abbr,
        operatoryName: operatories.name
      })
      .from(appointments)
      .leftJoin(patients, and(
        eq(patients.locationId, appointments.locationId),
        eq(patients.sourceId, appointments.patientSourceId)))
      .leftJoin(providers, and(
        eq(providers.locationId, appointments.locationId),
        eq(providers.sourceId, appointments.providerSourceId)))
      .leftJoin(operatories, and(
        eq(operatories.locationId, appointments.locationId),
        eq(operatories.sourceId, appointments.operatorySourceId)))
      .where(and(
        eq(appointments.locationId, loc.id),
        gte(appointments.startsAt, day),
        lte(appointments.startsAt, dayEnd),
        // Doctors see their own column of the day, not the whole book.
        (() => {
          const psid = providerScopeOf(user);
          return psid != null ? eq(appointments.providerSourceId, psid) : sql`true`;
        })()
      ))
      .orderBy(asc(appointments.startsAt));

    const ops = await this.db.select().from(operatories)
      .where(eq(operatories.locationId, loc.id)).orderBy(asc(operatories.itemOrder));
    return { location: { id: loc.id, key: loc.key, name: loc.name }, date: day.toISOString().slice(0, 10), operatories: ops, appointments: rows };
  }

  /** "My patient" = primary provider is me, or I have an appointment with them. */
  private myPatientFilter(locationId: number, psid: number) {
    const seenByMe = this.db
      .select({ pat: appointments.patientSourceId })
      .from(appointments)
      .where(and(
        eq(appointments.locationId, locationId),
        eq(appointments.providerSourceId, psid)
      ));
    return or(
      eq(patients.primaryProviderSourceId, psid),
      inArray(patients.sourceId, seenByMe)
    );
  }

  async searchPatients(user: SessionUser, locationId: number | undefined, q: string) {
    const loc = await this.resolveLocation(user, locationId);
    const term = `%${q.trim()}%`;
    const psid = providerScopeOf(user);
    return this.db
      .select({
        sourceId: patients.sourceId,
        firstName: patients.firstName,
        lastName: patients.lastName,
        birthdate: patients.birthdate,
        wirelessPhone: patients.wirelessPhone,
        email: patients.email,
        city: patients.city,
        status: patients.status
      })
      .from(patients)
      .where(and(
        eq(patients.locationId, loc.id),
        q ? or(ilike(patients.lastName, term), ilike(patients.firstName, term)) : sql`true`,
        psid != null ? this.myPatientFilter(loc.id, psid) : sql`true`
      ))
      .orderBy(asc(patients.lastName))
      .limit(25);
  }

  /** Throws unless a provider-scoped user is linked to this patient. */
  async assertPatientAccess(user: SessionUser, locationId: number, patientSourceId: number): Promise<void> {
    const psid = providerScopeOf(user);
    if (psid == null) return;
    const [row] = await this.db
      .select({ sourceId: patients.sourceId })
      .from(patients)
      .where(and(
        eq(patients.locationId, locationId),
        eq(patients.sourceId, patientSourceId),
        this.myPatientFilter(locationId, psid)
      ));
    if (!row) throw new ForbiddenException("Not your patient — provider accounts see only their own patients");
  }

  /** Of `candidateIds`, the ones a provider-scoped user may see (all, if unscoped). */
  async allowedPatientIds(user: SessionUser, locationId: number, candidateIds: number[]): Promise<Set<number>> {
    const psid = providerScopeOf(user);
    if (psid == null || candidateIds.length === 0) return new Set(candidateIds);
    const rows = await this.db
      .select({ sourceId: patients.sourceId })
      .from(patients)
      .where(and(
        eq(patients.locationId, locationId),
        inArray(patients.sourceId, candidateIds),
        this.myPatientFilter(locationId, psid)
      ));
    return new Set(rows.map((r) => r.sourceId));
  }

  async patientTimeline(user: SessionUser, locationId: number, sourceId: number) {
    const loc = await this.resolveLocation(user, locationId);
    await this.assertPatientAccess(user, loc.id, sourceId);
    const [patient] = await this.db.select().from(patients)
      .where(and(eq(patients.locationId, loc.id), eq(patients.sourceId, sourceId)));
    if (!patient) throw new NotFoundException("Patient not found");

    const appts = await this.db.select().from(appointments)
      .where(and(eq(appointments.locationId, loc.id), eq(appointments.patientSourceId, sourceId)))
      .orderBy(desc(appointments.startsAt)).limit(50);
    const procs = await this.db
      .select({
        sourceId: procedures.sourceId, procDate: procedures.procDate, fee: procedures.fee,
        status: procedures.status, toothNum: procedures.toothNum,
        procCode: procedureCodes.procCode, description: procedureCodes.description
      })
      .from(procedures)
      .leftJoin(procedureCodes, and(
        eq(procedureCodes.locationId, procedures.locationId),
        eq(procedureCodes.sourceId, procedures.codeSourceId)))
      .where(and(eq(procedures.locationId, loc.id), eq(procedures.patientSourceId, sourceId)))
      .orderBy(desc(procedures.procDate)).limit(100);
    const notes = await this.db.select().from(commLogs)
      .where(and(eq(commLogs.locationId, loc.id), eq(commLogs.patientSourceId, sourceId)))
      .orderBy(desc(commLogs.happenedAt)).limit(50);
    const patClaims = await this.db.select().from(claims)
      .where(and(eq(claims.locationId, loc.id), eq(claims.patientSourceId, sourceId)))
      .orderBy(desc(claims.dateService)).limit(25);
    const [recall] = await this.db.select().from(recalls)
      .where(and(eq(recalls.locationId, loc.id), eq(recalls.patientSourceId, sourceId)));
    const patplanRows = await this.db
      .select({ ordinal: patPlans.ordinal, subscriberId: patPlans.subscriberId, carrierName: insPlans.carrierName })
      .from(patPlans)
      .leftJoin(insPlans, and(
        eq(insPlans.locationId, patPlans.locationId),
        eq(insPlans.sourceId, patPlans.planSourceId)))
      .where(and(eq(patPlans.locationId, loc.id), eq(patPlans.patientSourceId, sourceId)));

    // B3: pre-auth status per procedure — the chart badge that tells the
    // provider a planned crown/SRP is cleared (or blocked) with the payer.
    const preauthRows = await this.db
      .select({
        procedureSourceId: preauths.procedureSourceId,
        status: preauths.status,
        missingItem: preauths.missingItem
      })
      .from(preauths)
      .where(and(eq(preauths.locationId, loc.id), eq(preauths.patientSourceId, sourceId)));

    return { location: { id: loc.id, key: loc.key, name: loc.name }, patient, appointments: appts, procedures: procs, notes, claims: patClaims, recall: recall ?? null, insurance: patplanRows, preauths: preauthRows };
  }

  async auditEntries(user: SessionUser, limit = 100) {
    assertCan(user, "audit.read"); // compliance surface — the owner's view
    return this.db.select().from(auditLog)
      .where(eq(auditLog.orgId, user.orgId))
      .orderBy(desc(auditLog.at))
      .limit(Math.min(limit, 500));
  }
}
