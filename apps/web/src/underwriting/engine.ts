import type {
  AssetClass,
  Assumptions,
  Building,
  LineItem,
  Returns,
  Statement,
  Underwriting
} from '../types';

export const defaultAssumptions = (assetClass: AssetClass): Assumptions => ({
  rent_growth_pct: 0.03,
  vacancy_pct: assetClass === 'hospitality' ? 0.35 : 0.05,
  expense_growth_pct: 0.025,
  mgmt_fee_pct: assetClass === 'multifamily' ? 0.03 : 0.04,
  capex_reserve_per_unit: assetClass === 'multifamily' ? 300 : 0,
  ti_lc_reserve_per_sf: ['office', 'retail', 'industrial', 'mixed-use'].includes(assetClass) ? 1.5 : 0,
  exit_cap: 0.06,
  hold_years: 5,
  ltv: 0.65,
  rate: 0.065,
  amort_years: 30
});

export const emptyStatement = (): Statement => ({
  revenue: [],
  expenses: [],
  noi: 0
});

export function sum(items: LineItem[]): number {
  return items.reduce((a, b) => a + (Number.isFinite(b.amount) ? b.amount : 0), 0);
}

export function computeNoi(s: Statement): number {
  return sum(s.revenue) - sum(s.expenses);
}

export function defaultTtmTemplate(building: Building): Statement {
  const units = building.units ?? 0;
  const sf = building.sf ?? 0;
  const nrsf = building.nrsf ?? sf;
  const keys = building.keys ?? 0;
  const occupancy = building.occupancy ?? 0.9;
  switch (building.asset_class) {
    case 'multifamily':
      return {
        revenue: [
          { label: 'Gross Potential Rent', amount: units * 1800 * 12 },
          { label: 'Other Income (RUBS, fees, parking)', amount: units * 50 * 12 },
          { label: 'Vacancy & Credit Loss', amount: -(units * 1800 * 12) * 0.05 }
        ],
        expenses: [
          { label: 'Property Taxes', amount: units * 1200 },
          { label: 'Insurance', amount: units * 400 },
          { label: 'Utilities', amount: units * 600 },
          { label: 'Repairs & Maintenance', amount: units * 500 },
          { label: 'Turnover', amount: units * 300 },
          { label: 'Management Fee', amount: units * 1800 * 12 * 0.03 },
          { label: 'Payroll', amount: units * 500 },
          { label: 'Marketing', amount: units * 100 },
          { label: 'G&A', amount: units * 150 }
        ],
        noi: 0
      };
    case 'office':
    case 'retail':
    case 'industrial':
    case 'mixed-use':
      return {
        revenue: [
          { label: 'Base Rent', amount: sf * 28 },
          { label: 'Expense Reimbursements (NNN)', amount: sf * 7 },
          { label: 'Other Income', amount: 0 },
          { label: 'Vacancy & Credit Loss', amount: -sf * 28 * 0.1 }
        ],
        expenses: [
          { label: 'Property Taxes', amount: sf * 3.5 },
          { label: 'Insurance', amount: sf * 0.6 },
          { label: 'CAM', amount: sf * 2.5 },
          { label: 'Utilities', amount: sf * 1.0 },
          { label: 'Repairs & Maintenance', amount: sf * 0.75 },
          { label: 'Management Fee', amount: sf * 28 * 0.04 },
          { label: 'G&A', amount: sf * 0.25 }
        ],
        noi: 0
      };
    case 'hospitality':
      return {
        revenue: [
          { label: 'Rooms Revenue', amount: keys * 365 * 150 * occupancy },
          { label: 'F&B Revenue', amount: keys * 365 * 25 * occupancy },
          { label: 'Other Revenue', amount: keys * 365 * 10 * occupancy }
        ],
        expenses: [
          { label: 'Rooms Department', amount: keys * 365 * 45 * occupancy },
          { label: 'F&B Department', amount: keys * 365 * 20 * occupancy },
          { label: 'A&G', amount: keys * 2500 },
          { label: 'Sales & Marketing', amount: keys * 2000 },
          { label: 'Utilities', amount: keys * 1800 },
          { label: 'Property Operations', amount: keys * 1500 },
          { label: 'Management Fee', amount: keys * 365 * 185 * occupancy * 0.04 },
          { label: 'Property Taxes', amount: keys * 2200 },
          { label: 'Insurance', amount: keys * 700 }
        ],
        noi: 0
      };
    case 'self-storage':
      return {
        revenue: [
          { label: 'Rental Income', amount: nrsf * 14 * occupancy },
          { label: 'Tenant Insurance / Admin', amount: nrsf * 1.5 * occupancy },
          { label: 'Vacancy & Credit Loss', amount: -nrsf * 14 * 0.1 }
        ],
        expenses: [
          { label: 'Payroll', amount: 65000 },
          { label: 'Property Taxes', amount: nrsf * 0.75 },
          { label: 'Insurance', amount: nrsf * 0.25 },
          { label: 'Utilities', amount: nrsf * 0.2 },
          { label: 'Repairs & Maintenance', amount: nrsf * 0.3 },
          { label: 'Management Fee', amount: nrsf * 14 * occupancy * 0.06 },
          { label: 'Marketing', amount: nrsf * 0.5 }
        ],
        noi: 0
      };
    case 'land':
      return {
        revenue: [],
        expenses: [{ label: 'Carry (taxes, insurance)', amount: 0 }],
        noi: 0
      };
    case 'other':
    default:
      return { revenue: [], expenses: [], noi: 0 };
  }
}

export function buildProformaFromTtm(ttm: Statement, a: Assumptions): Statement {
  const revenue = ttm.revenue.map((li) => ({
    label: li.label,
    amount: Math.round(li.amount * (1 + a.rent_growth_pct))
  }));
  const expenses = ttm.expenses.map((li) => ({
    label: li.label,
    amount: Math.round(li.amount * (1 + a.expense_growth_pct))
  }));
  const s: Statement = { revenue, expenses, noi: 0 };
  s.noi = computeNoi(s);
  return s;
}

// Net Operating Income scaling base used for proforma gross rent (vacancy already in revenue, but we normalize).
function grossRentBase(s: Statement): number {
  const rent = s.revenue
    .filter((li) => /rent|rooms|rental/i.test(li.label) && li.amount > 0)
    .reduce((a, b) => a + b.amount, 0);
  return rent;
}

// IRR via bisection / Newton, robust for monthly or annual series.
export function irr(cashflows: number[], guess = 0.1): number | null {
  if (cashflows.length < 2) return null;
  const npv = (r: number) => cashflows.reduce((acc, cf, t) => acc + cf / Math.pow(1 + r, t), 0);
  // Bracket search
  let low = -0.99;
  let high = 10.0;
  const nLow = npv(low);
  const nHigh = npv(high);
  if (Number.isNaN(nLow) || Number.isNaN(nHigh)) return null;
  if (nLow * nHigh > 0) {
    // try Newton as fallback
    let r = guess;
    for (let i = 0; i < 200; i++) {
      const f = npv(r);
      const eps = 1e-6;
      const df = (npv(r + eps) - f) / eps;
      if (!Number.isFinite(df) || df === 0) break;
      const nr = r - f / df;
      if (!Number.isFinite(nr)) break;
      if (Math.abs(nr - r) < 1e-8) return nr;
      r = nr;
    }
    return null;
  }
  for (let i = 0; i < 200; i++) {
    const mid = (low + high) / 2;
    const nMid = npv(mid);
    if (Math.abs(nMid) < 1e-8) return mid;
    if (nLow * nMid < 0) {
      high = mid;
    } else {
      low = mid;
    }
  }
  return (low + high) / 2;
}

// Mortgage constant monthly payment; returns negative cashflow (out).
export function mortgagePayment(principal: number, annualRate: number, years: number): number {
  if (principal <= 0) return 0;
  const n = years * 12;
  const r = annualRate / 12;
  if (r === 0) return principal / n;
  return (principal * r) / (1 - Math.pow(1 + r, -n));
}

export function computeReturns(
  building: Building,
  ttm: Statement,
  proforma: Statement,
  a: Assumptions
): Returns {
  const price = building.asking_price ?? 0;
  if (price <= 0 || building.asset_class === 'land') {
    return { irr: null, equity_multiple: null, coc_yr1: null, dscr: null };
  }
  const loan = price * a.ltv;
  const equity = price - loan;
  const debtService = mortgagePayment(loan, a.rate, a.amort_years ?? 30) * 12;

  const capexPerUnit = a.capex_reserve_per_unit || 0;
  const tilcPerSf = a.ti_lc_reserve_per_sf || 0;
  const units = building.units ?? 0;
  const keys = building.keys ?? 0;
  const sf = building.sf ?? 0;
  const reserves = capexPerUnit * Math.max(units, keys) + tilcPerSf * sf;

  const proformaNoi = computeNoi(proforma) - reserves;

  // Year 1 levered cashflow
  const yr1Cf = proformaNoi - debtService;
  const coc = equity > 0 ? yr1Cf / equity : null;
  const dscr = debtService > 0 ? computeNoi(proforma) / debtService : null;

  // Build hold period cashflows with simple rent/expense growth
  const years = Math.max(1, Math.floor(a.hold_years || 5));
  const cashflows: number[] = [-equity];
  let currentRev = sum(proforma.revenue);
  let currentExp = sum(proforma.expenses);
  for (let y = 1; y <= years; y++) {
    const noi = currentRev - currentExp - reserves;
    let cf = noi - debtService;
    if (y === years) {
      const exitNoi = currentRev * (1 + a.rent_growth_pct) - currentExp * (1 + a.expense_growth_pct) - reserves;
      const saleProceeds = a.exit_cap > 0 ? exitNoi / a.exit_cap : 0;
      // assume interest-only estimate of remaining balance: approximate balance via amortization
      const balance = remainingBalance(loan, a.rate, a.amort_years ?? 30, y);
      cf += saleProceeds - balance;
    }
    cashflows.push(cf);
    currentRev *= 1 + a.rent_growth_pct;
    currentExp *= 1 + a.expense_growth_pct;
  }
  const irrVal = irr(cashflows);
  const totalDistributions = cashflows.slice(1).reduce((a, b) => a + b, 0);
  const em = equity > 0 ? (equity + totalDistributions) / equity : null;
  void grossRentBase(ttm); // kept for future UI
  return {
    irr: irrVal,
    equity_multiple: em,
    coc_yr1: coc,
    dscr
  };
}

export function remainingBalance(principal: number, annualRate: number, years: number, elapsedYears: number): number {
  if (principal <= 0) return 0;
  const r = annualRate / 12;
  const n = years * 12;
  const k = elapsedYears * 12;
  if (r === 0) return principal * (1 - k / n);
  const pmt = mortgagePayment(principal, annualRate, years);
  return principal * Math.pow(1 + r, k) - pmt * ((Math.pow(1 + r, k) - 1) / r);
}

export function blankUnderwriting(building: Building): Underwriting {
  const a = defaultAssumptions(building.asset_class);
  const ttm = defaultTtmTemplate(building);
  ttm.noi = computeNoi(ttm);
  const proforma = buildProformaFromTtm(ttm, a);
  const returns = computeReturns(building, ttm, proforma, a);
  return {
    building_id: building.id ?? '',
    asset_class: building.asset_class,
    ttm,
    proforma_12mo: proforma,
    assumptions: a,
    returns,
    version: 1
  };
}
