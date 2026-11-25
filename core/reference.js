// Reference data and business configuration for the PCS prototype.
// Every value tagged GUESS is illustrative and must be replaced with the authorities' official figures.

export const ORG_TYPES = {
  NPA:         { label: 'Port Authority', short: 'Port Authority', regulator: true },
  CUSTOMS:     { label: 'Customs Service', short: 'Customs', regulator: true },
  SHIPPING:    { label: 'Shipping Line / Agent', short: 'Shipping' },
  TERMINAL:    { label: 'Terminal Operator', short: 'Terminal' },
  FORWARDER:   { label: 'Freight Forwarder / Clearing Agent', short: 'Forwarder' },
  IMPORTER:    { label: 'Cargo Owner (Importer/Exporter)', short: 'Cargo owner' },
  OGA:         { label: 'Other Government Agency', short: 'Agency', regulator: true },
  BANK:        { label: 'Bank / Payment Provider', short: 'Bank' },
  TRANSPORTER: { label: 'Transporter / Haulier', short: 'Transporter' },
  AUDIT:       { label: 'Audit & Compliance', short: 'Audit', regulator: true },
};

// Role-based access: which org types may issue each command. `admin` = only the org's admin users.
export const PERMISSIONS = {
  'org.register':        ['*public'],
  'org.approve':         ['NPA:admin'],
  'org.suspend':         ['NPA:admin'],
  'org.apikey.rotate':   ['*:admin'],
  'user.create':         ['*:admin'],
  'user.setActive':      ['*:admin'],
  'vessel.register':     ['SHIPPING', 'NPA'],
  'voyage.create':       ['SHIPPING'],
  'voyage.arrive':       ['NPA'],
  'voyage.depart':       ['NPA'],
  'manifest.submit':     ['SHIPPING'],
  'manifest.amend':      ['SHIPPING'],
  'service.request':     ['SHIPPING', 'FORWARDER', 'IMPORTER'],
  'service.decide':      ['NPA', 'SHIPPING', 'TERMINAL', 'OGA', 'TRANSPORTER'],
  'cargo.discharge':     ['TERMINAL'],
  'declaration.lodge':   ['FORWARDER', 'IMPORTER'],
  'declaration.review':  ['CUSTOMS'],
  'declaration.respond': ['FORWARDER', 'IMPORTER'],
  'exam.record':         ['CUSTOMS'],
  'payment.pay':         ['FORWARDER', 'IMPORTER', 'SHIPPING'],
  'payment.reconcile':   ['BANK'],
  'terminal.release':    ['TERMINAL'],
  'release.approve':     ['NPA'],
  'gate.out':            ['TERMINAL'],
  'delivery.confirm':    ['FORWARDER', 'IMPORTER'],
  'notification.read':   ['*'],
  'clock.advance':       ['NPA:admin'],
  'settings.update':     ['NPA:admin'],
};

// Which org type decides each service request type, and the SLA in hours (GUESS).
export const SERVICE_TYPES = {
  BERTH:          { label: 'Berth allocation', decider: 'NPA', requester: ['SHIPPING'], slaHours: 24 },
  PERMIT:         { label: 'Regulatory permit', decider: 'OGA', requester: ['FORWARDER', 'IMPORTER'], slaHours: 48 },
  DELIVERY_ORDER: { label: 'Delivery order', decider: 'SHIPPING', requester: ['FORWARDER', 'IMPORTER'], slaHours: 24 },
  EXAM_POSITION:  { label: 'Container positioning for exam', decider: 'TERMINAL', requester: ['SYSTEM'], slaHours: 24 },
  TRUCK_BOOKING:  { label: 'Truck booking (call-up)', decider: 'TRANSPORTER', requester: ['FORWARDER', 'IMPORTER'], slaHours: 12 },
};

export const PORTS = {
  APAPA:  { name: 'Lagos Port Complex (Apapa)', berths: ['APP-B01', 'APP-B02', 'APP-B03', 'APP-B04', 'APP-B05', 'APP-B06'] },
  TINCAN: { name: 'Tin Can Island Port', berths: ['TCI-B01', 'TCI-B02', 'TCI-B03', 'TCI-B04'] },
  ONNE:   { name: 'Onne Port Complex', berths: ['ONN-B01', 'ONN-B02', 'ONN-B03'] },
};

// Mini tariff (HS heading level). Duty rates follow the ECOWAS CET bands; exact rates are GUESS.
// permits: which agency category must approve; risk: inherent risk weight; minUsdPerKg: undervaluation threshold.
export const TARIFF = {
  '0402': { desc: 'Milk and cream, concentrated', duty: 0.20, permits: ['FOOD'], risk: 10, minUsdPerKg: 2.0 },
  '1006': { desc: 'Rice', duty: 0.10, permits: ['FOOD'], risk: 20, minUsdPerKg: 0.4 },
  '1701': { desc: 'Cane or beet sugar', duty: 0.10, permits: ['FOOD'], risk: 5, minUsdPerKg: 0.3 },
  '2402': { desc: 'Cigars and cigarettes', duty: 0.35, permits: ['FOOD'], risk: 40, minUsdPerKg: 15 },
  '3004': { desc: 'Medicaments, packaged doses', duty: 0.05, permits: ['FOOD'], risk: 35, minUsdPerKg: 8 },
  '3923': { desc: 'Plastic packing articles', duty: 0.20, permits: ['STANDARDS'], risk: 0, minUsdPerKg: 1.2 },
  '6403': { desc: 'Footwear, leather uppers', duty: 0.20, permits: ['STANDARDS'], risk: 10, minUsdPerKg: 6 },
  '7214': { desc: 'Iron or steel bars and rods', duty: 0.10, permits: ['STANDARDS'], risk: 5, minUsdPerKg: 0.5 },
  '8471': { desc: 'Computers and units thereof', duty: 0.05, permits: [], risk: 10, minUsdPerKg: 20 },
  '8517': { desc: 'Telephones and smartphones', duty: 0.05, permits: ['STANDARDS'], risk: 20, minUsdPerKg: 40 },
  '8703': { desc: 'Motor cars', duty: 0.35, permits: ['STANDARDS'], risk: 25, minUsdPerKg: 3 },
  '8418': { desc: 'Refrigerators and freezers', duty: 0.20, permits: ['STANDARDS'], risk: 5, minUsdPerKg: 3 },
};

// Customs Procedure Codes (subset).
export const CPC = { '4000': 'Home use (import for consumption)', '7100': 'Warehousing', '8000': 'Transit' };

export const DEFAULT_SETTINGS = {
  fxNgnPerUsd: 1550,          // GUESS: exchange rate used for valuation
  cifFactor: 1.10,            // GUESS: CIF estimated as FOB x 1.10 when freight/insurance not declared
  vatRate: 0.075,             // VAT on (CIF + duty)
  cissRate: 0.01,             // Comprehensive Import Supervision Scheme, on FOB (GUESS basis)
  etlsRate: 0.005,            // ECOWAS Trade Liberalisation Scheme levy, on CIF
  npaDuesPerTeu: 18000,       // GUESS: port authority cargo dues, NGN per TEU
  terminalHandlingPerTeu: 145000, // GUESS: NGN per TEU
  storageFreeDays: 3,         // GUESS
  storagePerTeuDay: 9500,     // GUESS: NGN per TEU per day after free days
  shippingDoFee: 65000,       // GUESS: per bill of lading
  shippingPerTeu: 40000,      // GUESS: container deposit/charges per TEU
  examPenaltyRate: 0.15,      // GUESS: penalty on additional duty found at exam
  riskYellowAt: 30, riskRedAt: 60, randomSelectionPct: 5,
  gatePassValidHours: 72,     // GUESS
  autoReleaseOrder: false,    // if true the Port Authority release order is issued automatically when all checks pass
  highRiskOrigins: ['XX'],    // placeholder list; real list comes from Customs intelligence
};

export const YARD = { blocks: ['A', 'B', 'C', 'D'], bays: 8, rows: 4, tiers: 3 };

// ISO 6346 container number check digit.
export function iso6346CheckDigit(code10) {
  const map = {}; let v = 10;
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') { if (v % 11 === 0) v++; map[ch] = v++; }
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = code10[i];
    const n = /[0-9]/.test(ch) ? Number(ch) : map[ch];
    sum += n * Math.pow(2, i);
  }
  return (sum % 11) % 10;
}
export function validContainerNo(no) {
  if (!/^[A-Z]{3}[UJZ][0-9]{7}$/.test(no || '')) return false;
  return iso6346CheckDigit(no.slice(0, 10)) === Number(no[10]);
}
export function makeContainerNo(owner, serial) {
  const base = owner + 'U' + String(serial).padStart(6, '0');
  return base + iso6346CheckDigit(base);
}
export const teu = (size) => (String(size) === '40' || String(size) === '45' ? 2 : 1);
