"""Underwriting math: NOI, proforma, IRR, equity multiple, CoC, DSCR."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np


@dataclass
class Returns:
    irr: float | None
    equity_multiple: float | None
    coc_yr1: float | None
    dscr: float | None


def _sum_lines(lines: list[dict[str, Any]]) -> float:
    total = 0.0
    for li in lines:
        amt = li.get("amount") if isinstance(li, dict) else None
        if amt is None:
            continue
        try:
            total += float(amt)
        except (TypeError, ValueError):
            continue
    return total


def compute_noi(statement: dict[str, Any]) -> float:
    rev = _sum_lines(statement.get("revenue", []) or [])
    exp = _sum_lines(statement.get("expenses", []) or [])
    return rev - exp


def build_proforma_from_ttm(ttm: dict[str, Any], a: dict[str, float]) -> dict[str, Any]:
    rent_growth = float(a.get("rent_growth_pct", 0.03))
    expense_growth = float(a.get("expense_growth_pct", 0.025))
    revenue = [
        {"label": li.get("label", ""), "amount": round(float(li.get("amount", 0.0)) * (1 + rent_growth))}
        for li in (ttm.get("revenue") or [])
    ]
    expenses = [
        {"label": li.get("label", ""), "amount": round(float(li.get("amount", 0.0)) * (1 + expense_growth))}
        for li in (ttm.get("expenses") or [])
    ]
    noi = sum(li["amount"] for li in revenue) - sum(li["amount"] for li in expenses)
    return {"revenue": revenue, "expenses": expenses, "noi": noi}


def mortgage_payment(principal: float, annual_rate: float, years: int) -> float:
    if principal <= 0:
        return 0.0
    n = years * 12
    r = annual_rate / 12.0
    if r == 0:
        return principal / n
    return principal * r / (1 - (1 + r) ** (-n))


def remaining_balance(principal: float, annual_rate: float, years: int, elapsed_years: int) -> float:
    if principal <= 0:
        return 0.0
    r = annual_rate / 12.0
    k = elapsed_years * 12
    if r == 0:
        return principal * (1 - k / (years * 12))
    pmt = mortgage_payment(principal, annual_rate, years)
    return principal * (1 + r) ** k - pmt * (((1 + r) ** k - 1) / r)


def irr(cashflows: list[float]) -> float | None:
    """Robust IRR via bisection with Newton fallback. Cashflows indexed by period (annual)."""
    if len(cashflows) < 2:
        return None
    cf = np.array(cashflows, dtype=float)
    if not np.isfinite(cf).all():
        return None

    def npv(rate: float) -> float:
        t = np.arange(len(cf))
        return float(np.sum(cf / (1.0 + rate) ** t))

    low, high = -0.99, 10.0
    n_low, n_high = npv(low), npv(high)
    if not (np.isfinite(n_low) and np.isfinite(n_high)):
        return None
    if n_low * n_high > 0:
        # Newton fallback
        r = 0.1
        for _ in range(200):
            f = npv(r)
            eps = 1e-6
            df = (npv(r + eps) - f) / eps
            if df == 0 or not np.isfinite(df):
                break
            r_next = r - f / df
            if not np.isfinite(r_next):
                break
            if abs(r_next - r) < 1e-8:
                return float(r_next)
            r = r_next
        return None
    for _ in range(200):
        mid = (low + high) / 2.0
        n_mid = npv(mid)
        if abs(n_mid) < 1e-8:
            return float(mid)
        if n_low * n_mid < 0:
            high = mid
        else:
            low = mid
            n_low = n_mid
    return float((low + high) / 2.0)


def compute_returns(
    building: dict[str, Any],
    ttm: dict[str, Any],
    proforma: dict[str, Any],
    a: dict[str, float],
) -> Returns:
    asset_class = building.get("asset_class", "multifamily")
    price = float(building.get("asking_price") or 0)
    if price <= 0 or asset_class == "land":
        return Returns(irr=None, equity_multiple=None, coc_yr1=None, dscr=None)
    ltv = float(a.get("ltv", 0.65))
    rate = float(a.get("rate", 0.065))
    amort_years = int(a.get("amort_years", 30))
    hold_years = max(1, int(a.get("hold_years", 5)))
    exit_cap = float(a.get("exit_cap", 0.06))
    rent_growth = float(a.get("rent_growth_pct", 0.03))
    expense_growth = float(a.get("expense_growth_pct", 0.025))
    capex_per_unit = float(a.get("capex_reserve_per_unit", 0) or 0)
    tilc_per_sf = float(a.get("ti_lc_reserve_per_sf", 0) or 0)

    loan = price * ltv
    equity = price - loan
    debt_service_annual = mortgage_payment(loan, rate, amort_years) * 12

    units = int(building.get("units") or 0)
    keys = int(building.get("keys") or 0)
    sf = int(building.get("sf") or 0)
    reserves = capex_per_unit * max(units, keys) + tilc_per_sf * sf

    proforma_noi = compute_noi(proforma) - reserves
    yr1_cf = proforma_noi - debt_service_annual
    coc = (yr1_cf / equity) if equity > 0 else None
    dscr = (compute_noi(proforma) / debt_service_annual) if debt_service_annual > 0 else None

    current_rev = _sum_lines(proforma.get("revenue", []))
    current_exp = _sum_lines(proforma.get("expenses", []))
    cashflows: list[float] = [-equity]
    for y in range(1, hold_years + 1):
        noi_y = current_rev - current_exp - reserves
        cf = noi_y - debt_service_annual
        if y == hold_years:
            exit_noi = current_rev * (1 + rent_growth) - current_exp * (1 + expense_growth) - reserves
            sale_proceeds = (exit_noi / exit_cap) if exit_cap > 0 else 0.0
            balance = remaining_balance(loan, rate, amort_years, y)
            cf += sale_proceeds - balance
        cashflows.append(cf)
        current_rev *= 1 + rent_growth
        current_exp *= 1 + expense_growth

    irr_val = irr(cashflows)
    total_dist = sum(cashflows[1:])
    em = ((equity + total_dist) / equity) if equity > 0 else None
    return Returns(irr=irr_val, equity_multiple=em, coc_yr1=coc, dscr=dscr)


def default_assumptions(asset_class: str) -> dict[str, float]:
    return {
        "rent_growth_pct": 0.03,
        "vacancy_pct": 0.35 if asset_class == "hospitality" else 0.05,
        "expense_growth_pct": 0.025,
        "mgmt_fee_pct": 0.03 if asset_class == "multifamily" else 0.04,
        "capex_reserve_per_unit": 300.0 if asset_class == "multifamily" else 0.0,
        "ti_lc_reserve_per_sf": 1.5 if asset_class in {"office", "retail", "industrial", "mixed-use"} else 0.0,
        "exit_cap": 0.06,
        "hold_years": 5,
        "ltv": 0.65,
        "rate": 0.065,
        "amort_years": 30,
    }
