"""TEFAP / Maryland Food Bank monthly compliance CSV."""

from __future__ import annotations

from calendar import monthrange
from csv import writer as csv_writer
from datetime import date, datetime, timezone
from io import StringIO
from typing import Any, Mapping, Sequence


def month_bounds(year: int, month: int) -> tuple[date, date]:
    last_day = monthrange(year, month)[1]
    return date(year, month, 1), date(year, month, last_day)


def family_size_breakdown(household_sizes: Sequence[int]) -> dict[str, int]:
    buckets = {str(n): 0 for n in range(1, 8)}
    buckets["8+"] = 0
    for size in household_sizes:
        if size >= 8:
            buckets["8+"] += 1
        elif size >= 1:
            buckets[str(int(size))] += 1
    return buckets


def reconstruct_pounds(
    *,
    household_size: int,
    estimated_lbs: float | None,
    distribution_model: str | None,
    default_pack_lbs: float,
) -> float:
    if estimated_lbs is not None:
        return float(estimated_lbs)
    model = (distribution_model or "client_choice").lower()
    if model == "pre_packed":
        return float(default_pack_lbs)
    return float(household_size) * float(default_pack_lbs)


def build_monthly_report_csv(
    *,
    pantry_name: str,
    pantry_id: str,
    year: int,
    month: int,
    current_model: str,
    checkins: Sequence[Mapping[str, Any]],
    default_pack_lbs: float,
) -> str:
    start, _end = month_bounds(year, month)
    sizes = [int(row["household_size"]) for row in checkins]
    buckets = family_size_breakdown(sizes)
    pounds = 0.0
    model_counts: dict[str, int] = {}
    for row in checkins:
        model = row.get("distribution_model") or current_model or "client_choice"
        model_counts[str(model)] = model_counts.get(str(model), 0) + 1
        pounds += reconstruct_pounds(
            household_size=int(row["household_size"]),
            estimated_lbs=row.get("estimated_lbs"),
            distribution_model=model,
            default_pack_lbs=default_pack_lbs,
        )

    buf = StringIO()
    writer = csv_writer(buf)
    writer.writerow(["Find Food Baltimore — TEFAP / Maryland Food Bank Monthly Report"])
    writer.writerow(["Pantry", pantry_name])
    writer.writerow(["Pantry ID", pantry_id])
    writer.writerow(["Month", start.strftime("%Y-%m")])
    writer.writerow(["Generated (UTC)", datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")])
    writer.writerow(["Distribution model (current)", current_model])
    writer.writerow([])
    writer.writerow(["Metric", "Value"])
    writer.writerow(["Households served", len(checkins)])
    writer.writerow(["Individuals served", sum(sizes)])
    writer.writerow(["Estimated / recorded pounds distributed", round(pounds, 2)])
    writer.writerow([])
    writer.writerow(["Family size", "Households"])
    for key in ["1", "2", "3", "4", "5", "6", "7", "8+"]:
        writer.writerow([key, buckets[key]])
    writer.writerow([])
    writer.writerow(["Distribution model used at check-in", "Households"])
    if model_counts:
        for model, count in sorted(model_counts.items()):
            writer.writerow([model, count])
    else:
        writer.writerow(["(none)", 0])
    writer.writerow([])
    writer.writerow(["Notes"])
    writer.writerow(
        [
            "Pounds are estimated from check-ins × pantry allocation rates "
            "(client choice / list) or 1 fixed pack per visit (pre-packed boxes), "
            "plus any quantities logged on list-style orders."
        ]
    )
    return buf.getvalue()
