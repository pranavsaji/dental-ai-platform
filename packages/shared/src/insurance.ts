// ---------------------------------------------------------------------------
// Insurance domain data shared between the seeder (A3), the mock
// clearinghouse (B1), and the denial workflows (B4). One source of truth:
// the seeder writes these facts into the sim insplan rows, and payer-side
// mocks answer from the same rules — so eligibility/denial demos are
// internally consistent, not two unrelated random streams.
// ---------------------------------------------------------------------------

export interface PlanFrequencyRules {
  /** Prophylaxis (D1110) allowance per calendar year. */
  prophyPerYear: number;
  /** Bitewing series (D0274) allowance per calendar year. */
  bitewingsPerYear: number;
  /** Crown replacement clock, years per tooth (D27xx). */
  crownYearsPerTooth: number;
  /** SRP (D4341) allowance per quadrant per N months. */
  srpMonthsPerQuadrant: number;
}

export interface CarrierRules {
  carrierName: string;
  payerId: string;
  carrierPhone: string;
  annualMax: number;
  deductible: number;
  frequency: PlanFrequencyRules;
}

// Deterministic per-carrier benefit profiles. Carrier names match the seeded
// insplan rows exactly — lookups are by carrierName.
export const CARRIER_RULES: CarrierRules[] = [
  { carrierName: "Delta Dental of Texas", payerId: "94276", carrierPhone: "(800) 521-2651", annualMax: 1500, deductible: 50,  frequency: { prophyPerYear: 2, bitewingsPerYear: 1, crownYearsPerTooth: 5, srpMonthsPerQuadrant: 24 } },
  { carrierName: "MetLife",               payerId: "65978", carrierPhone: "(800) 942-0854", annualMax: 2000, deductible: 50,  frequency: { prophyPerYear: 2, bitewingsPerYear: 1, crownYearsPerTooth: 5, srpMonthsPerQuadrant: 24 } },
  { carrierName: "Cigna Dental",          payerId: "62308", carrierPhone: "(800) 244-6224", annualMax: 1000, deductible: 75,  frequency: { prophyPerYear: 2, bitewingsPerYear: 1, crownYearsPerTooth: 7, srpMonthsPerQuadrant: 36 } },
  { carrierName: "Aetna",                 payerId: "60054", carrierPhone: "(877) 238-6200", annualMax: 1500, deductible: 50,  frequency: { prophyPerYear: 2, bitewingsPerYear: 2, crownYearsPerTooth: 5, srpMonthsPerQuadrant: 24 } },
  { carrierName: "Guardian",              payerId: "64246", carrierPhone: "(888) 600-1600", annualMax: 1250, deductible: 50,  frequency: { prophyPerYear: 2, bitewingsPerYear: 1, crownYearsPerTooth: 5, srpMonthsPerQuadrant: 24 } },
  { carrierName: "United Concordia",      payerId: "89070", carrierPhone: "(800) 332-0366", annualMax: 1000, deductible: 100, frequency: { prophyPerYear: 2, bitewingsPerYear: 1, crownYearsPerTooth: 8, srpMonthsPerQuadrant: 36 } },
  { carrierName: "Humana Dental",         payerId: "73288", carrierPhone: "(800) 233-4013", annualMax: 1500, deductible: 50,  frequency: { prophyPerYear: 2, bitewingsPerYear: 1, crownYearsPerTooth: 5, srpMonthsPerQuadrant: 24 } },
  { carrierName: "Principal",             payerId: "61271", carrierPhone: "(800) 247-4695", annualMax: 2000, deductible: 25,  frequency: { prophyPerYear: 3, bitewingsPerYear: 1, crownYearsPerTooth: 5, srpMonthsPerQuadrant: 24 } },
  { carrierName: "BCBS of Texas",         payerId: "84980", carrierPhone: "(800) 521-2227", annualMax: 1500, deductible: 50,  frequency: { prophyPerYear: 2, bitewingsPerYear: 1, crownYearsPerTooth: 5, srpMonthsPerQuadrant: 24 } },
  { carrierName: "Sun Life",              payerId: "70408", carrierPhone: "(800) 442-7742", annualMax: 1200, deductible: 50,  frequency: { prophyPerYear: 2, bitewingsPerYear: 1, crownYearsPerTooth: 6, srpMonthsPerQuadrant: 24 } }
];

export function carrierRules(carrierName: string): CarrierRules | undefined {
  return CARRIER_RULES.find((c) => c.carrierName === carrierName);
}

// Claim Adjustment Reason Codes used across seeding (A3), denial
// classification (B4), and the billing UI (B5). The static map IS the
// deterministic classifier; the LLM may refine within a category, never
// contradict it.
export type DenialCategory =
  | "missing_documentation"
  | "frequency"
  | "not_covered"
  | "coordination_of_benefits"
  | "medical_necessity"
  | "administrative";

export const CARC_CODES: Record<string, { description: string; category: DenialCategory; appealable: boolean }> = {
  "16":  { description: "Claim lacks information or has submission/billing error", category: "missing_documentation", appealable: true },
  "22":  { description: "Care may be covered by another payer per coordination of benefits", category: "coordination_of_benefits", appealable: true },
  "45":  { description: "Charge exceeds fee schedule/maximum allowable", category: "administrative", appealable: false },
  "50":  { description: "Non-covered service — not deemed a medical necessity", category: "medical_necessity", appealable: true },
  "96":  { description: "Non-covered charge per plan benefits", category: "not_covered", appealable: true },
  "97":  { description: "Benefit included in payment for another service (bundled)", category: "administrative", appealable: false },
  "119": { description: "Benefit maximum for this period has been reached", category: "frequency", appealable: false },
  "197": { description: "Precertification/authorization absent", category: "missing_documentation", appealable: true }
};

// Deterministic CARC→category classifier (B4). The most severe/actionable code
// wins: any appealable code makes the denial appealable, and the category comes
// from the first appealable code (else the first known code). This static map
// is the guardrail — an LLM may refine the summary within the category, never
// contradict it.
export function classifyDenial(carcCodes: string[]): {
  category: DenialCategory;
  appealable: boolean;
  descriptions: string[];
} {
  const known = carcCodes.map((c) => ({ code: c.trim(), info: CARC_CODES[c.trim()] })).filter((c) => c.info);
  if (known.length === 0) {
    return { category: "administrative", appealable: false, descriptions: [] };
  }
  const lead = known.find((c) => c.info!.appealable) ?? known[0];
  return {
    category: lead.info!.category,
    appealable: known.some((c) => c.info!.appealable),
    descriptions: known.map((c) => `CARC ${c.code}: ${c.info!.description}`)
  };
}

// Pre-authorization (B3): CDT code families that require payer pre-auth in the
// sim. The plan placed a `requiresPreauth` column on the sim schema; instead
// this shared helper is the single source of truth and the canonical
// procedure_codes.requiresPreauth column is derived from it at ingest — no
// PMS schema churn, and the mock clearinghouse answers from the same facts.
const PREAUTH_CODE_PREFIXES = [
  "D27", // crowns
  "D28", // onlays / partial crowns
  "D4341", "D4342", // scaling & root planing per quadrant
  "D6" // implants / prosthodontics
];

export function requiresPreauth(procCode: string): boolean {
  return PREAUTH_CODE_PREFIXES.some((p) => procCode.startsWith(p));
}
