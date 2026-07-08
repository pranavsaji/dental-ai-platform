// Clinical note templates keyed by procedure code prefix. These populate
// commlog (CommType 3) and become the RAG corpus for the clinical agent,
// so they read like real chart notes.

export function clinicalNote(procCode: string, tooth: string, provAbbr: string): string {
  switch (procCode) {
    case "D1110":
    case "D1120":
      return pick([
        `Pt presents for routine prophy. Generalized light supragingival calculus, localized moderate interproximal plaque. Probing depths 2-3mm, no BOP except localized #30 distal. Scaled and polished all quadrants, flossed. OHI reviewed - recommended electric brush and daily flossing. Tissue healthy. Recommend 6mo recall. ${provAbbr}`,
        `Prophylaxis completed. Moderate staining lower anteriors from coffee, removed with cavitron and prophy paste. Gingiva pink and firm, no recession noted. Pt reports no sensitivity. Reviewed brushing technique at gumline. Next recall 6 months. ${provAbbr}`,
        `Adult prophy. Light calculus lower anterior linguals. Isolated 4mm pocket #18 mesial - monitoring, discussed possible SRP if deepens. Applied fluoride varnish. Pt declines BWX today, due next visit. Recall 6mo. ${provAbbr}`
      ]);
    case "D4341":
      return `SRP ${tooth ? "quadrant of #" + tooth : "UR quadrant"} under local anesthetic (2% lido 1:100k epi). Heavy subgingival calculus removed, root surfaces planed smooth. 4-6mm pockets with generalized BOP in treated quad. Post-op instructions given: warm salt water rinses, chlorhexidine 0.12% BID x 2 weeks. Re-eval in 4-6 weeks. ${provAbbr}`;
    case "D4910":
      return `Perio maintenance. Pockets stable vs last charting, isolated 5mm #2 DB and #15 ML. Light BOP. Subgingival instrumentation all quads, polished. Reinforced interdental brush use. Continue 4mo perio maintenance interval. ${provAbbr}`;
    case "D2140":
    case "D2330":
    case "D2391":
    case "D2392":
      return `Composite restoration tooth #${tooth}. Caries excavated, no pulp exposure. Etched, bonded (OptiBond), incremental composite fill, cured, occlusion adjusted and polished. Pt tolerated well, advised possible transient sensitivity 1-2 weeks. ${provAbbr}`;
    case "D2740":
    case "D2750":
      return `Crown prep #${tooth}. Existing large restoration with recurrent decay removed. Buildup placed prn. Full coverage prep, retraction cord, PVS impression, shade A2 selected. Temp crown cemented with TempBond. Lab case sent - seat in 2-3 weeks. Advised to avoid sticky foods on temp. ${provAbbr}`;
    case "D3310":
    case "D3330":
      return `RCT #${tooth}. Dx: irreversible pulpitis, pt reported lingering thermal pain. Access, working length confirmed with apex locator + PA. Canals instrumented rotary files, irrigated NaOCl, obturated gutta percha + sealer. Post-op PA acceptable. Rx ibuprofen 600mg. Needs buildup + crown - discussed, pt will schedule. ${provAbbr}`;
    case "D7140":
    case "D7210":
      return `Extraction #${tooth}. Reviewed health hx, no contraindications. Local anesthetic achieved, tooth elevated and delivered ${procCodeIsSurgical(procCode) ? "with buccal bone removal and sectioning" : "intact with forceps"}. Hemostasis with gauze pressure. Post-op instructions given verbally and written: no smoking, no straws 72h. Rx ibuprofen. Discussed replacement options: implant vs bridge. ${provAbbr}`;
    case "D9110":
      return `Emergency visit - pt reports severe pain ${tooth ? "#" + tooth : "LR quadrant"}, worse at night, sensitive to cold. PA shows periapical radiolucency. Palliative tx: excavated gross caries, sedative filling placed. Discussed RCT vs extraction. Pt to schedule definitive tx. Rx amoxicillin 500mg TID x7d given swelling. ${provAbbr}`;
    case "D0120":
    case "D0150":
      return pick([
        `Exam completed. Reviewed radiographs: no new interproximal caries. Existing restorations intact. Soft tissue WNL, oral cancer screening negative. Class I occlusion. Watch #14 occlusal staining - not cavitated, apply fluoride and monitor. ${provAbbr}`,
        `Comprehensive exam. Charted existing restorations. Findings: recurrent decay #19 MO under existing amalgam - recommend replace with composite; moderate wear facets, discussed nightguard. Perio: generalized 2-3mm, localized 4mm posterior. Tx plan presented and printed for pt. ${provAbbr}`
      ]);
    default:
      return `Procedure ${procCode}${tooth ? " tooth #" + tooth : ""} completed without complication. Post-op instructions reviewed. ${provAbbr}`;
  }
}

function procCodeIsSurgical(code: string): boolean {
  return code === "D7210";
}

let pickCounter = 0;
function pick<T>(arr: T[]): T {
  // Deterministic rotation rather than RNG so notes vary but seeding stays reproducible.
  pickCounter += 1;
  return arr[pickCounter % arr.length];
}
