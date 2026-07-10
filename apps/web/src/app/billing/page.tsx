"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useApp } from "@/components/shell";
import { Card, Chip, Empty, PageTitle, StatTile, Td, Th, fmtDate, fmtMoney } from "@/components/ui";

interface Summary {
  ar: Record<"0-30" | "31-60" | "61-90" | "90+", number>;
  openClaims: number;
  openClaimsValue: number;
  denialCount: number;
  openAppeals: number;
  eligibilityExceptions: number;
  openPreauths: number;
  preauthsNeedingInfo: number;
}

interface ClaimRow {
  sourceId: number;
  patientSourceId: number;
  patientName: string;
  carrierName: string;
  dateService: string | null;
  dateSent: string | null;
  status: string;
  claimFee: number;
  carcCodes: string;
  ageDays: number;
  bucket: string;
  priority: number;
}

interface DenialRow {
  id: number;
  claimSourceId: number;
  patientSourceId: number;
  patientFirst: string | null;
  patientLast: string | null;
  carcCodes: string;
  category: string;
  appealable: boolean;
  agentSummary: string;
  appealStatus: string;
  createdAt: string;
}

interface PreauthRow {
  id: number;
  patientSourceId: number;
  patientFirst: string | null;
  patientLast: string | null;
  procCode: string;
  fee: number;
  status: string;
  missingItem: string;
  payerReference: string | null;
  createdAt: string;
}

interface EligRow {
  patientSourceId: number;
  status: string;
  summary: string;
  checkedAt: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  missing_documentation: "Missing documentation",
  frequency: "Frequency",
  not_covered: "Not covered",
  coordination_of_benefits: "COB",
  medical_necessity: "Medical necessity",
  administrative: "Administrative"
};

const APPEAL_CHIP: Record<string, string> = {
  none: "bg-line/70 text-ink-soft",
  drafted: "bg-amber-soft text-amber",
  pending_approval: "bg-amber-soft text-amber",
  sent: "bg-mint text-pine",
  won: "bg-mint text-pine",
  lost: "bg-coral-soft text-coral"
};

export default function BillingPage() {
  const { location } = useApp();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [claims, setClaims] = useState<ClaimRow[]>([]);
  const [denials, setDenials] = useState<DenialRow[]>([]);
  const [preauthRows, setPreauthRows] = useState<PreauthRow[]>([]);
  const [exceptions, setExceptions] = useState<EligRow[]>([]);
  const [bucket, setBucket] = useState("");
  const [sort, setSort] = useState("priority");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const load = useCallback(() => {
    if (!location) return;
    const loc = `locationId=${location.id}`;
    api<Summary>(`/portal/billing/summary?${loc}`).then(setSummary).catch(() => {});
    const params = new URLSearchParams({ locationId: String(location.id), sort });
    if (bucket) params.set("bucket", bucket);
    api<ClaimRow[]>(`/portal/billing/claims?${params}`).then(setClaims).catch(() => {});
    api<DenialRow[]>(`/portal/billing/denials?${loc}`).then(setDenials).catch(() => {});
    api<PreauthRow[]>(`/portal/billing/preauths?${loc}`).then(setPreauthRows).catch(() => {});
    api<EligRow[]>(`/portal/billing/eligibility?${loc}`)
      .then((rows) => setExceptions(rows.filter((r) => r.status !== "verified")))
      .catch(() => {});
  }, [location, bucket, sort]);

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  async function followUp(sourceId: number) {
    if (!location) return;
    setBusy(`fu-${sourceId}`);
    try {
      await api(`/portal/billing/claims/${sourceId}/follow-up?locationId=${location.id}`, { method: "POST" });
      setNotice(`Follow-up workflow started for claim ${sourceId} — review the drafted letter in Approvals.`);
    } catch (e) {
      setNotice(`Could not start follow-up: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function runSweep() {
    if (!location) return;
    setBusy("sweep");
    try {
      await api(`/portal/billing/eligibility-sweep?locationId=${location.id}`, { method: "POST" });
      setNotice("Eligibility sweep started for the next 3 days of appointments — badges and tasks update as checks land.");
    } catch (e) {
      setNotice(`Could not start sweep: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <PageTitle kicker="Revenue cycle" title="Billing" />
      <p className="rise rise-1 -mt-3 mb-5 max-w-2xl text-sm text-ink-soft">
        Work the revenue cycle without touching the PMS: AR aging, open claims ranked by a
        transparent priority score, classified denials with drafted appeals, pre-auth status,
        and eligibility exceptions.
      </p>

      {notice && (
        <div className="rise mb-4 rounded-md border border-teal/40 bg-mint/40 px-4 py-2.5 text-sm text-pine">
          {notice}
          <button className="ml-3 text-xs underline" onClick={() => setNotice("")}>dismiss</button>
        </div>
      )}

      {summary && (
        <>
          <div className="mb-3 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatTile label="AR 0–30" value={fmtMoney(summary.ar["0-30"])} tone="default" />
            <StatTile label="AR 31–60" value={fmtMoney(summary.ar["31-60"])} tone="default" delay="rise-1" />
            <StatTile label="AR 61–90" value={fmtMoney(summary.ar["61-90"])} tone="warn" delay="rise-2" />
            <StatTile label="AR 90+" value={fmtMoney(summary.ar["90+"])} tone="alert" delay="rise-3" />
          </div>
          <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatTile label="Open claims" value={summary.openClaims} detail={`${fmtMoney(summary.openClaimsValue)} outstanding`} />
            <StatTile label="Denials" value={summary.denialCount} detail={`${summary.openAppeals} appeal${summary.openAppeals === 1 ? "" : "s"} in flight`} tone={summary.denialCount > 0 ? "warn" : "default"} delay="rise-1" />
            <StatTile label="Eligibility exceptions" value={summary.eligibilityExceptions} detail="latest check red/amber" tone={summary.eligibilityExceptions > 0 ? "warn" : "good"} delay="rise-2" />
            <StatTile label="Open pre-auths" value={summary.openPreauths} detail={summary.preauthsNeedingInfo > 0 ? `${summary.preauthsNeedingInfo} need info` : "none blocked"} delay="rise-3" />
          </div>
        </>
      )}

      {/* Eligibility exceptions strip (B2 worklist) */}
      <Card
        title="Eligibility exceptions"
        className="rise rise-2 mb-6"
        action={
          <button
            disabled={busy === "sweep"}
            onClick={runSweep}
            className="rounded-md bg-pine px-3 py-1.5 text-xs font-semibold text-white hover:bg-pine-2 disabled:opacity-50"
          >
            ✳ Run eligibility sweep
          </button>
        }
      >
        {exceptions.length === 0 ? (
          <Empty text="No eligibility exceptions. Run a sweep to verify the upcoming schedule." />
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-line/70">
                <Th>Status</Th><Th>Patient</Th><Th>Payer response</Th><Th>Checked</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/50">
              {exceptions.slice(0, 8).map((e) => (
                <tr key={e.patientSourceId}>
                  <Td>
                    <span className={`inline-block rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
                      e.status === "inactive" || e.status === "failed" ? "bg-coral-soft text-coral" : "bg-amber-soft text-amber"
                    }`}>{e.status}</span>
                  </Td>
                  <Td>
                    <Link href={`/patients/${location!.id}/${e.patientSourceId}`} className="font-medium hover:text-teal">
                      Patient <span className="num">{e.patientSourceId}</span>
                    </Link>
                  </Td>
                  <Td className="max-w-xl text-ink-soft">{e.summary}</Td>
                  <Td className="text-ink-soft">{fmtDate(e.checkedAt)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* Claims worklist */}
      <Card
        title="Open claims"
        className="rise rise-2 mb-6"
        action={
          <div className="flex items-center gap-2 text-xs">
            <select
              className="rounded-md border border-line bg-surface px-2 py-1 text-xs outline-none focus:border-teal"
              value={bucket} onChange={(e) => setBucket(e.target.value)}
            >
              <option value="">All ages</option>
              <option value="0-30">0–30 days</option>
              <option value="31-60">31–60 days</option>
              <option value="61-90">61–90 days</option>
              <option value="90+">90+ days</option>
            </select>
            <select
              className="rounded-md border border-line bg-surface px-2 py-1 text-xs outline-none focus:border-teal"
              value={sort} onChange={(e) => setSort(e.target.value)}
            >
              <option value="priority">By priority</option>
              <option value="age">By age</option>
              <option value="fee">By fee</option>
            </select>
          </div>
        }
      >
        {claims.length === 0 ? (
          <Empty text="No open claims in this bucket." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-line/70">
                  <Th>Priority</Th><Th>Age</Th><Th>Patient</Th><Th>Carrier</Th><Th>Fee</Th><Th>Status</Th><Th className="text-right">Action</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/50">
                {claims.slice(0, 30).map((c) => (
                  <tr key={c.sourceId} className="hover:bg-mint/25">
                    <Td>
                      <span
                        className="num font-semibold"
                        title={`score = age(${c.ageDays}) + fee/100(${Math.round(c.claimFee / 100)})${c.carcCodes ? " + denied(40)" : ""} — deterministic, higher = work first`}
                      >
                        {c.priority}
                      </span>
                    </Td>
                    <Td className="num text-ink-soft">{c.ageDays}d</Td>
                    <Td>
                      <Link href={`/patients/${location!.id}/${c.patientSourceId}`} className="font-medium hover:text-teal">
                        {c.patientName}
                      </Link>
                    </Td>
                    <Td className="text-ink-soft">{c.carrierName}</Td>
                    <Td className="num">{fmtMoney(c.claimFee)}</Td>
                    <Td><Chip value={c.status} />{c.carcCodes && <span className="ml-1 text-[11px] text-coral">CARC {c.carcCodes}</span>}</Td>
                    <Td className="text-right">
                      <button
                        disabled={busy === `fu-${c.sourceId}`}
                        onClick={() => followUp(c.sourceId)}
                        className="rounded-md border border-line px-3 py-1.5 text-xs text-ink-soft hover:border-teal hover:text-teal disabled:opacity-50"
                      >
                        Follow up
                      </button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Denials queue (B4) */}
      <Card title="Denials" className="rise rise-3 mb-6">
        {denials.length === 0 ? (
          <Empty text="No classified denials. Denied claims land here with a category and a drafted appeal." />
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-line/70">
                <Th>Category</Th><Th>Claim</Th><Th>Patient</Th><Th>Summary</Th><Th>Appeal</Th><Th>When</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/50">
              {denials.map((d) => (
                <tr key={d.id}>
                  <Td>
                    <span className="inline-block rounded-full bg-line/70 px-2.5 py-0.5 text-[11px] font-medium text-ink-soft">
                      {CATEGORY_LABELS[d.category] ?? d.category}
                    </span>
                    {d.carcCodes && <div className="mt-0.5 text-[11px] text-ink-faint">CARC {d.carcCodes}</div>}
                  </Td>
                  <Td className="num">{d.claimSourceId}</Td>
                  <Td>
                    <Link href={`/patients/${location!.id}/${d.patientSourceId}`} className="font-medium hover:text-teal">
                      {d.patientLast ? `${d.patientLast}, ${d.patientFirst}` : `Patient ${d.patientSourceId}`}
                    </Link>
                  </Td>
                  <Td className="max-w-md text-xs leading-relaxed text-ink-soft">{d.agentSummary}</Td>
                  <Td>
                    <span className={`inline-block rounded-full px-2.5 py-0.5 text-[11px] font-medium ${APPEAL_CHIP[d.appealStatus] ?? "bg-line/70 text-ink-soft"}`}>
                      {d.appealable ? d.appealStatus.replace(/_/g, " ") : "not appealable"}
                    </span>
                    {(d.appealStatus === "pending_approval" || d.appealStatus === "drafted") && (
                      <div className="mt-0.5 text-[11px]">
                        <Link href="/approvals" className="text-teal hover:underline">review in Approvals →</Link>
                      </div>
                    )}
                  </Td>
                  <Td className="text-ink-soft">{fmtDate(d.createdAt)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* Pre-auth status (B3) */}
      <Card title="Pre-authorizations" className="rise rise-3">
        {preauthRows.length === 0 ? (
          <Empty text="No pre-authorizations yet. Treatment-planning a crown, SRP, or implant starts one automatically." />
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-line/70">
                <Th>Status</Th><Th>Patient</Th><Th>Procedure</Th><Th>Fee</Th><Th>Payer ref</Th><Th>Notes</Th><Th>When</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/50">
              {preauthRows.map((p) => (
                <tr key={p.id}>
                  <Td>
                    <span className={`inline-block rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
                      p.status === "approved" ? "bg-mint text-pine" :
                      p.status === "denied" ? "bg-coral-soft text-coral" :
                      p.status === "more_info" ? "bg-amber-soft text-amber" :
                      "bg-line/70 text-ink-soft"
                    }`}>{p.status.replace(/_/g, " ")}</span>
                  </Td>
                  <Td>
                    <Link href={`/patients/${location!.id}/${p.patientSourceId}`} className="font-medium hover:text-teal">
                      {p.patientLast ? `${p.patientLast}, ${p.patientFirst}` : `Patient ${p.patientSourceId}`}
                    </Link>
                  </Td>
                  <Td className="num">{p.procCode}</Td>
                  <Td className="num">{fmtMoney(p.fee)}</Td>
                  <Td className="num text-ink-soft">{p.payerReference ?? "—"}</Td>
                  <Td className="max-w-xs text-xs text-ink-soft">{p.missingItem || ""}</Td>
                  <Td className="text-ink-soft">{fmtDate(p.createdAt)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
