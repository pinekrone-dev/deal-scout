export type AssetClass =
  | 'multifamily'
  | 'office'
  | 'retail'
  | 'industrial'
  | 'hospitality'
  | 'mixed-use'
  | 'land'
  | 'self-storage'
  | 'other';

export const ASSET_CLASSES: AssetClass[] = [
  'multifamily',
  'office',
  'retail',
  'industrial',
  'hospitality',
  'mixed-use',
  'land',
  'self-storage',
  'other'
];

export type Building = {
  id?: string;
  address: string;
  city?: string;
  state?: string;
  zip?: string;
  asset_class: AssetClass;
  units?: number | null;
  sf?: number | null;
  nrsf?: number | null; // net rentable sf (self-storage)
  keys?: number | null; // hospitality room count
  zoning?: string | null; // land
  entitlements?: string | null; // land
  year_built?: number | null;
  year_renovated?: number | null;
  occupancy?: number | null; // 0..1
  current_noi?: number | null;
  asking_price?: number | null;
  cap_rate?: number | null; // 0..1
  adr?: number | null; // hospitality
  revpar?: number | null; // hospitality
  notes?: string;
  photos?: string[];
  documents?: string[];
  lat?: number;
  lng?: number;
  owner_uid?: string;
  created_at?: number;
  updated_at?: number;
};

export type ContactRole = 'broker' | 'sponsor' | 'owner' | 'lender' | 'tenant' | 'other';

export type Contact = {
  id?: string;
  name: string;
  role: ContactRole;
  firm?: string;
  email?: string;
  phone?: string;
  linkedin?: string;
  notes?: string;
  related_buildings?: string[];
  related_deals?: string[];
  created_at?: number;
  updated_at?: number;
};

export type DealStatus = 'sourcing' | 'underwriting' | 'loi' | 'diligence' | 'won' | 'lost';

export const DEAL_STATUSES: DealStatus[] = [
  'sourcing',
  'underwriting',
  'loi',
  'diligence',
  'won',
  'lost'
];

export type Deal = {
  id?: string;
  building_id: string;
  contact_ids: string[];
  status: DealStatus;
  source?: string;
  deadline?: number | null;
  notes?: string;
  created_at?: number;
  updated_at?: number;
};

export type LineItem = { label: string; amount: number };

export type RentRollRow = {
  unit: string;
  unit_type?: string;
  sf?: number | null;
  rent?: number | null;
  status?: 'occupied' | 'vacant' | 'model' | 'down';
  lease_end?: string | null;
};

export type LeaseRollRow = {
  tenant: string;
  suite?: string;
  sf?: number | null;
  rent_psf?: number | null; // annual $/sf
  start?: string | null;
  expiration?: string | null;
  options?: string | null;
  recovery?: string | null; // NNN / MG / FS
};

export type Assumptions = {
  rent_growth_pct: number; // 0..1
  vacancy_pct: number; // 0..1
  expense_growth_pct: number; // 0..1
  mgmt_fee_pct: number; // 0..1
  capex_reserve_per_unit: number; // $ per unit per year (MF) or per key (hotel) or per sf (office/retail/industrial)
  ti_lc_reserve_per_sf?: number; // office/retail/industrial
  exit_cap: number; // 0..1
  hold_years: number; // integer years
  ltv: number; // 0..1
  rate: number; // 0..1
  amort_years?: number;
};

export type Statement = {
  revenue: LineItem[];
  expenses: LineItem[];
  noi: number;
};

// Monthly breakdown of a statement. `months` is an array of YYYY-MM strings
// (exactly 12 entries, oldest first). Each line item has an `amounts` array
// of 12 monthly values aligned with `months`.
export type MonthlyLine = { label: string; amounts: number[] };
export type MonthlyStatement = {
  months: string[];
  revenue: MonthlyLine[];
  expenses: MonthlyLine[];
  source?: 'om' | 'derived' | 'manual';
};

export type Returns = {
  irr: number | null;
  equity_multiple: number | null;
  coc_yr1: number | null;
  dscr: number | null;
};

export type Underwriting = {
  id?: string;
  building_id: string;
  asset_class: AssetClass;
  ttm: Statement;
  ttm_period?: { start_month?: string; end_month?: string; label?: string };
  ttm_monthly?: MonthlyStatement | null; // populated by OM when available
  proforma_12mo: Statement;
  proforma_12mo_monthly?: MonthlyStatement | null; // populated by OM or derived
  assumptions: Assumptions;
  rent_roll?: RentRollRow[]; // multifamily
  lease_roll?: LeaseRollRow[]; // office / retail / industrial
  returns: Returns;
  version: number;
  created_at?: number;
};

export type OmIngestion = {
  id?: string;
  storage_path: string | string[];
  building_id: string | null;
  extraction_status: 'pending' | 'running' | 'done' | 'error';
  raw_extraction: Record<string, unknown> | null;
  confirmed_at?: number | null;
  error?: string | null;
  created_at?: number;
};
