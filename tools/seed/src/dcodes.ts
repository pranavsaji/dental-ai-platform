// Common CDT procedure codes used by the simulator.
// fee = typical UCR fee, minutes = chair time, hygiene = performed by hygienist.
export interface DCode {
  code: string;
  descript: string;
  abbr: string;
  fee: number;
  minutes: number;
  hygiene: boolean;
}

export const D_CODES: DCode[] = [
  { code: "D0120", descript: "Periodic oral evaluation - established patient", abbr: "PerEx", fee: 65, minutes: 10, hygiene: false },
  { code: "D0150", descript: "Comprehensive oral evaluation - new or established patient", abbr: "CompEx", fee: 110, minutes: 30, hygiene: false },
  { code: "D0210", descript: "Intraoral - complete series of radiographic images", abbr: "FMX", fee: 150, minutes: 20, hygiene: true },
  { code: "D0220", descript: "Intraoral - periapical first radiographic image", abbr: "PA", fee: 35, minutes: 5, hygiene: true },
  { code: "D0274", descript: "Bitewings - four radiographic images", abbr: "4BW", fee: 75, minutes: 10, hygiene: true },
  { code: "D0330", descript: "Panoramic radiographic image", abbr: "Pano", fee: 130, minutes: 10, hygiene: true },
  { code: "D1110", descript: "Prophylaxis - adult", abbr: "ProphyAd", fee: 115, minutes: 40, hygiene: true },
  { code: "D1120", descript: "Prophylaxis - child", abbr: "ProphyCh", fee: 85, minutes: 30, hygiene: true },
  { code: "D1206", descript: "Topical application of fluoride varnish", abbr: "FlVarn", fee: 45, minutes: 5, hygiene: true },
  { code: "D1351", descript: "Sealant - per tooth", abbr: "Seal", fee: 60, minutes: 10, hygiene: true },
  { code: "D2140", descript: "Amalgam - one surface, primary or permanent", abbr: "Amal1", fee: 175, minutes: 30, hygiene: false },
  { code: "D2330", descript: "Resin-based composite - one surface, anterior", abbr: "Comp1A", fee: 195, minutes: 30, hygiene: false },
  { code: "D2391", descript: "Resin-based composite - one surface, posterior", abbr: "Comp1P", fee: 210, minutes: 30, hygiene: false },
  { code: "D2392", descript: "Resin-based composite - two surfaces, posterior", abbr: "Comp2P", fee: 265, minutes: 40, hygiene: false },
  { code: "D2740", descript: "Crown - porcelain/ceramic", abbr: "CrownPC", fee: 1350, minutes: 90, hygiene: false },
  { code: "D2750", descript: "Crown - porcelain fused to high noble metal", abbr: "CrownPFM", fee: 1295, minutes: 90, hygiene: false },
  { code: "D2950", descript: "Core buildup, including any pins when required", abbr: "Buildup", fee: 320, minutes: 30, hygiene: false },
  { code: "D3310", descript: "Endodontic therapy, anterior tooth", abbr: "RCT-Ant", fee: 950, minutes: 90, hygiene: false },
  { code: "D3330", descript: "Endodontic therapy, molar tooth", abbr: "RCT-Mol", fee: 1400, minutes: 120, hygiene: false },
  { code: "D4341", descript: "Periodontal scaling and root planing - four or more teeth per quadrant", abbr: "SRP4+", fee: 285, minutes: 60, hygiene: true },
  { code: "D4910", descript: "Periodontal maintenance", abbr: "PerioMaint", fee: 160, minutes: 50, hygiene: true },
  { code: "D5110", descript: "Complete denture - maxillary", abbr: "CDMax", fee: 2100, minutes: 60, hygiene: false },
  { code: "D6010", descript: "Surgical placement of implant body: endosteal implant", abbr: "Implant", fee: 2400, minutes: 90, hygiene: false },
  { code: "D6058", descript: "Abutment supported porcelain/ceramic crown", abbr: "ImplCrown", fee: 1600, minutes: 60, hygiene: false },
  { code: "D7140", descript: "Extraction, erupted tooth or exposed root", abbr: "Ext", fee: 240, minutes: 30, hygiene: false },
  { code: "D7210", descript: "Extraction, erupted tooth requiring removal of bone", abbr: "SurgExt", fee: 385, minutes: 45, hygiene: false },
  { code: "D8090", descript: "Comprehensive orthodontic treatment of the adult dentition", abbr: "OrthoAd", fee: 5800, minutes: 60, hygiene: false },
  { code: "D9110", descript: "Palliative treatment of dental pain", abbr: "Palliative", fee: 120, minutes: 20, hygiene: false },
  { code: "D9230", descript: "Inhalation of nitrous oxide / analgesia, anxiolysis", abbr: "N2O", fee: 65, minutes: 0, hygiene: false },
  { code: "D9944", descript: "Occlusal guard - hard appliance, full arch", abbr: "NightGuard", fee: 550, minutes: 30, hygiene: false }
];
