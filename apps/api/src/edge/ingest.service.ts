import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  appointments, claimProcs, claims, commLogs, insPlans, operatories,
  patPlans, patientContactPrefs, patients, payments, procedureCodes,
  procedures, providers, recalls, syncEvents
} from "@dental/db";
import * as shared from "@dental/shared";
import { DB, type Db } from "../db";
import { HooksService } from "./hooks.service";
import type { EdgeSite } from "./edge-auth.guard";

// Idempotent canonical upserts. Every event is deduped on eventId first (the
// edge redelivers on any uncertainty), then upserted on (locationId, sourceId).

@Injectable()
export class IngestService {
  private readonly log = new Logger("Ingest");

  constructor(
    @Inject(DB) private db: Db,
    private hooks: HooksService
  ) {}

  async ingestBatch(site: EdgeSite, batch: shared.SyncBatch): Promise<shared.SyncBatchAck> {
    let accepted = 0;
    let duplicates = 0;
    for (const event of batch.events) {
      const schema = shared.PAYLOAD_SCHEMAS[event.table as shared.SyncTable];
      if (!schema) continue;
      const payload = schema.parse(event.payload);

      const inserted = await this.db
        .insert(syncEvents)
        .values({
          eventId: event.eventId,
          locationId: site.locationId,
          tableName: event.table,
          sourceId: event.sourceId
        })
        .onConflictDoNothing()
        .returning({ id: syncEvents.eventId });
      if (inserted.length === 0) {
        duplicates++;
        continue;
      }
      await this.upsert(site, event as shared.SyncEvent, payload);
      accepted++;
    }
    if (accepted > 0) this.log.log(`site ${site.siteKey}: accepted ${accepted} events (${duplicates} dup)`);
    return { accepted, duplicates };
  }

  private base(site: EdgeSite, event: shared.SyncEvent) {
    return {
      orgId: site.orgId,
      locationId: site.locationId,
      sourceId: event.sourceId,
      sourceStamp: new Date(event.stamp),
      syncedAt: new Date()
    };
  }

  private async upsert(site: EdgeSite, event: shared.SyncEvent, p: any): Promise<void> {
    const base = this.base(site, event);

    switch (event.table as shared.SyncTable) {
      case "provider":
        await this.db.insert(providers)
          .values({ ...base, abbr: p.abbr, lastName: p.lastName, firstName: p.firstName, specialty: p.specialty, isHidden: p.isHidden })
          .onConflictDoUpdate({
            target: [providers.locationId, providers.sourceId],
            set: { abbr: p.abbr, lastName: p.lastName, firstName: p.firstName, specialty: p.specialty, isHidden: p.isHidden, sourceStamp: base.sourceStamp, syncedAt: base.syncedAt }
          });
        break;
      case "operatory":
        await this.db.insert(operatories)
          .values({ ...base, name: p.name, abbrev: p.abbrev, itemOrder: p.itemOrder, defaultProviderSourceId: p.defaultProviderId, isHidden: p.isHidden })
          .onConflictDoUpdate({
            target: [operatories.locationId, operatories.sourceId],
            set: { name: p.name, abbrev: p.abbrev, itemOrder: p.itemOrder, defaultProviderSourceId: p.defaultProviderId, isHidden: p.isHidden, sourceStamp: base.sourceStamp, syncedAt: base.syncedAt }
          });
        break;
      case "procedurecode":
        await this.db.insert(procedureCodes)
          .values({ ...base, procCode: p.procCode, description: p.description, abbrDesc: p.abbrDesc })
          .onConflictDoUpdate({
            target: [procedureCodes.locationId, procedureCodes.sourceId],
            set: { procCode: p.procCode, description: p.description, abbrDesc: p.abbrDesc, sourceStamp: base.sourceStamp, syncedAt: base.syncedAt }
          });
        break;
      case "patient": {
        const values = {
          ...base,
          lastName: p.lastName, firstName: p.firstName, birthdate: p.birthdate,
          gender: p.gender, status: p.status, homePhone: p.homePhone,
          wirelessPhone: p.wirelessPhone, email: p.email, address: p.address,
          city: p.city, state: p.state, zip: p.zip,
          primaryProviderSourceId: p.primaryProviderId, firstVisit: p.firstVisit
        };
        const { orgId, locationId, sourceId, ...set } = values;
        await this.db.insert(patients).values(values)
          .onConflictDoUpdate({ target: [patients.locationId, patients.sourceId], set });
        // Contact-prefs mirror (A3/E1): PMS consent flows in at ingest, but a
        // platform-side opt-out (STOP reply) is sticky — a re-sync never
        // reinstates consent once optOutAt is set.
        await this.db.insert(patientContactPrefs).values({
          orgId: site.orgId,
          locationId: site.locationId,
          patientSourceId: event.sourceId,
          smsConsent: p.smsConsent,
          emailConsent: p.email !== "",
          preferredChannel: p.smsConsent && p.wirelessPhone !== "" ? "sms" : p.email !== "" ? "email" : "phone",
          updatedAt: new Date()
        }).onConflictDoUpdate({
          target: [patientContactPrefs.locationId, patientContactPrefs.patientSourceId],
          set: {
            smsConsent: sql`case when ${patientContactPrefs.optOutAt} is null then ${p.smsConsent} else false end`,
            emailConsent: p.email !== "",
            updatedAt: new Date()
          }
        });
        break;
      }
      case "appointment": {
        // Read previous state so status transitions (scheduled -> broken) can
        // trigger workflows exactly once, at ingest time.
        const [prev] = await this.db.select({ status: appointments.status, startsAt: appointments.startsAt })
          .from(appointments)
          .where(and(eq(appointments.locationId, site.locationId), eq(appointments.sourceId, event.sourceId)));
        const values = {
          ...base,
          patientSourceId: p.patientId, status: p.status,
          startsAt: new Date(p.startsAt), minutes: p.minutes, confirmed: p.confirmed,
          operatorySourceId: p.operatoryId, providerSourceId: p.providerId,
          note: p.note, procDescript: p.procDescript
        };
        const { orgId, locationId, sourceId, ...set } = values;
        await this.db.insert(appointments).values(values)
          .onConflictDoUpdate({ target: [appointments.locationId, appointments.sourceId], set });
        await this.hooks.onAppointmentUpserted(site, event.sourceId, prev?.status ?? null, p);
        break;
      }
      case "procedurelog": {
        const values = {
          ...base,
          patientSourceId: p.patientId, appointmentSourceId: p.appointmentId,
          procDate: p.procDate, fee: p.fee, status: p.status,
          providerSourceId: p.providerId, codeSourceId: p.codeId,
          toothNum: p.toothNum, surface: p.surface
        };
        const { orgId, locationId, sourceId, ...set } = values;
        await this.db.insert(procedures).values(values)
          .onConflictDoUpdate({ target: [procedures.locationId, procedures.sourceId], set });
        break;
      }
      case "insplan": {
        const values = {
          ...base, groupName: p.groupName, groupNum: p.groupNum, carrierName: p.carrierName,
          planType: p.planType, carrierPhone: p.carrierPhone, payerId: p.payerId,
          annualMax: p.annualMax, deductible: p.deductible
        };
        const { orgId, locationId, sourceId, ...set } = values;
        await this.db.insert(insPlans).values(values)
          .onConflictDoUpdate({ target: [insPlans.locationId, insPlans.sourceId], set });
        break;
      }
      case "patplan": {
        const values = { ...base, patientSourceId: p.patientId, planSourceId: p.planId, ordinal: p.ordinal, subscriberId: p.subscriberId };
        const { orgId, locationId, sourceId, ...set } = values;
        await this.db.insert(patPlans).values(values)
          .onConflictDoUpdate({ target: [patPlans.locationId, patPlans.sourceId], set });
        break;
      }
      case "claim": {
        const values = {
          ...base,
          patientSourceId: p.patientId, dateService: p.dateService, dateSent: p.dateSent,
          status: p.status, claimFee: p.claimFee, insPayEst: p.insPayEst, insPayAmt: p.insPayAmt,
          planSourceId: p.planId, providerSourceId: p.providerId, note: p.note,
          carcCodes: p.carcCodes
        };
        const { orgId, locationId, sourceId, ...set } = values;
        await this.db.insert(claims).values(values)
          .onConflictDoUpdate({ target: [claims.locationId, claims.sourceId], set });
        break;
      }
      case "claimproc": {
        const values = {
          ...base,
          claimSourceId: p.claimId, procedureSourceId: p.procedureId, patientSourceId: p.patientId,
          planSourceId: p.planId, received: p.received, feeBilled: p.feeBilled,
          insPayEst: p.insPayEst, insPayAmt: p.insPayAmt, writeOff: p.writeOff
        };
        const { orgId, locationId, sourceId, ...set } = values;
        await this.db.insert(claimProcs).values(values)
          .onConflictDoUpdate({ target: [claimProcs.locationId, claimProcs.sourceId], set });
        break;
      }
      case "recall": {
        const values = { ...base, patientSourceId: p.patientId, dateDue: p.dateDue, datePrevious: p.datePrevious, isDisabled: p.isDisabled };
        const { orgId, locationId, sourceId, ...set } = values;
        await this.db.insert(recalls).values(values)
          .onConflictDoUpdate({ target: [recalls.locationId, recalls.sourceId], set });
        break;
      }
      case "commlog": {
        const values = {
          ...base,
          patientSourceId: p.patientId, happenedAt: new Date(p.happenedAt),
          commType: p.commType, note: p.note, mode: p.mode, sentOrReceived: p.sentOrReceived
        };
        const { orgId, locationId, sourceId, ...set } = values;
        await this.db.insert(commLogs).values(values)
          .onConflictDoUpdate({ target: [commLogs.locationId, commLogs.sourceId], set });
        break;
      }
      case "payment": {
        const values = {
          ...base,
          patientSourceId: p.patientId, payDate: p.payDate,
          amount: p.amount, payType: p.payType, note: p.note
        };
        const { orgId, locationId, sourceId, ...set } = values;
        await this.db.insert(payments).values(values)
          .onConflictDoUpdate({ target: [payments.locationId, payments.sourceId], set });
        break;
      }
    }
  }
}
