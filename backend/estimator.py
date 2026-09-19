"""Predict-and-correct inventory state estimator.

Band mapping (lbs remaining):
    qty > 20          → plenty (green)
    5 <= qty <= 20    → low (amber)
    qty < 5           → out (red)

Depletion depends on the pantry's distribution_model:
    client_choice  household_size × lbs_per_person  (shop-the-shelves estimate)
    pre_packed     1 fixed pack per check-in (lbs_per_person per category)
    list           explicit order quantities, else typical list = client_choice math
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping, Optional, Sequence

PLENTY_THRESHOLD = 20.0  # exclusive: qty > 20 is plenty
LOW_THRESHOLD = 5.0  # inclusive lower bound of "low"

DEFAULT_LBS_PER_PERSON: dict[str, float] = {
    "produce": 2.0,
    "protein": 1.5,
    "dairy": 1.0,
    "grains": 1.5,
    "diapers": 0.5,
    "hygiene": 0.3,
    "canned goods": 2.0,
    "halal items": 1.5,
    "halal": 1.5,
}

BAND_SNAP_QTY = {
    "plenty": 25.0,
    "low": 12.0,
    "out": 0.0,
}

PREDICTION_CONFIDENCE_AFTER_TRUTH = 0.80
PREDICTION_CONFIDENCE_DECAY = 0.90
PREDICTION_CONFIDENCE_FLOOR = 0.40


def qty_to_band(qty: Optional[float]) -> str:
    """Map remaining estimated quantity onto a stock band."""
    remaining = 0.0 if qty is None else float(qty)
    if remaining > PLENTY_THRESHOLD:
        return "plenty"
    if remaining >= LOW_THRESHOLD:
        return "low"
    return "out"


def band_to_qty(band: str, current_qty: Optional[float] = None) -> float:
    """Snap a volunteer-confirmed band to a ground-truth quantity.

    If the current estimate already sits inside the confirmed band, keep it.
    Otherwise jump to a representative quantity for that band.
    """
    normalized = (band or "low").lower()
    current = None if current_qty is None else float(current_qty)

    if normalized == "plenty":
        if current is not None and current > PLENTY_THRESHOLD:
            return current
        return BAND_SNAP_QTY["plenty"]
    if normalized == "low":
        if current is not None and LOW_THRESHOLD <= current <= PLENTY_THRESHOLD:
            return current
        return BAND_SNAP_QTY["low"]
    if current is not None and current < LOW_THRESHOLD:
        return max(0.0, current)
    return BAND_SNAP_QTY["out"]


def next_prediction_confidence(previous_confidence: Optional[float], previous_source: Optional[str]) -> float:
    """Decay confidence after each predicted depletion; reset higher after a human/photo update."""
    source = (previous_source or "").lower()
    if source in {"volunteer_correction", "intake_photo", "manual", "client_feedback"}:
        return PREDICTION_CONFIDENCE_AFTER_TRUTH
    prev = PREDICTION_CONFIDENCE_AFTER_TRUTH if previous_confidence is None else float(previous_confidence)
    return round(max(PREDICTION_CONFIDENCE_FLOOR, prev * PREDICTION_CONFIDENCE_DECAY), 2)


def normalize_category_key(name: str) -> str:
    return (name or "").strip().lower()


def lbs_per_person_for(category_name: str, explicit: Optional[float] = None) -> float:
    if explicit is not None:
        return float(explicit)
    key = normalize_category_key(category_name)
    if key in DEFAULT_LBS_PER_PERSON:
        return DEFAULT_LBS_PER_PERSON[key]
    for needle, rate in DEFAULT_LBS_PER_PERSON.items():
        if needle in key:
            return rate
    return 1.0


def depletion_for_category(
    *,
    distribution_model: str,
    household_size: int,
    lbs_per_person: float,
    ordered_qty: Optional[float] = None,
) -> float:
    """How many units leave the shelf for one category on this check-in."""
    model = (distribution_model or "client_choice").lower()
    size = max(1, int(household_size))
    rate = float(lbs_per_person)

    if model == "pre_packed":
        return round(rate, 2)
    if model == "list":
        if ordered_qty is not None:
            return round(max(0.0, float(ordered_qty)), 2)
        return round(size * rate, 2)
    # client_choice / shop the shelves
    return round(size * rate, 2)


def apply_depletion(
    current_qty: Optional[float],
    depleted: float,
) -> float:
    remaining = 0.0 if current_qty is None else float(current_qty)
    return round(max(0.0, remaining - max(0.0, float(depleted))), 2)


def qty_from_band(band: Optional[str], estimated_qty: Optional[float] = None) -> float:
    """Seed a numeric estimate when the latest shelf row has a band but no quantity."""
    if estimated_qty is not None:
        return float(estimated_qty)
    return float(BAND_SNAP_QTY.get((band or "low").lower(), 12.0))


def estimate_checkin(
    *,
    distribution_model: str,
    household_size: int,
    shelf_rows: Sequence[Mapping[str, Any]],
    order_items: Optional[Iterable[Mapping[str, Any]]] = None,
) -> dict[str, Any]:
    """Pure predict-and-correct step for one household check-in.

    shelf_rows items support keys:
        category_id, category_name, category_emoji, estimated_qty, band,
        lbs_per_person, source, confidence
    order_items items support keys:
        category_id, category_name, quantity
    """
    orders_by_id: dict[Any, float] = {}
    orders_by_name: dict[str, float] = {}
    for item in order_items or []:
        qty = item.get("quantity")
        if qty is None:
            continue
        if item.get("category_id") is not None:
            orders_by_id[item["category_id"]] = float(qty)
        if item.get("category_name"):
            orders_by_name[normalize_category_key(str(item["category_name"]))] = float(qty)

    depletions: list[dict[str, Any]] = []
    estimated_lbs = 0.0

    for row in shelf_rows:
        name = row.get("category_name") or ""
        cat_id = row.get("category_id")
        rate = lbs_per_person_for(name, row.get("lbs_per_person"))
        ordered = None
        if cat_id in orders_by_id:
            ordered = orders_by_id[cat_id]
        elif normalize_category_key(name) in orders_by_name:
            ordered = orders_by_name[normalize_category_key(name)]

        depleted = depletion_for_category(
            distribution_model=distribution_model,
            household_size=household_size,
            lbs_per_person=rate,
            ordered_qty=ordered,
        )
        # List model with an explicit order: skip categories they didn't take.
        if (distribution_model or "").lower() == "list" and (orders_by_id or orders_by_name) and ordered is None:
            depleted = 0.0

        current_qty = qty_from_band(row.get("band"), row.get("estimated_qty"))
        remaining = apply_depletion(current_qty, depleted)
        band = qty_to_band(remaining)
        confidence = next_prediction_confidence(row.get("confidence"), row.get("source"))

        estimated_lbs += depleted
        depletions.append(
            {
                "category_id": cat_id,
                "category_name": name,
                "category_emoji": row.get("category_emoji") or "📦",
                "depleted": depleted,
                "previous_qty": current_qty,
                "remaining_qty": remaining,
                "band": band,
                "previous_band": row.get("band") or qty_to_band(current_qty),
                "confidence": confidence,
                "source": "prediction",
                "lbs_per_person": rate,
            }
        )

    return {
        "distribution_model": (distribution_model or "client_choice").lower(),
        "household_size": max(1, int(household_size)),
        "estimated_lbs": round(estimated_lbs, 2),
        "depletions": depletions,
    }


def snap_corrections(
    corrections: Sequence[Mapping[str, Any]],
    shelf_rows: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Turn volunteer closing-check bands into ground-truth shelf rows (confidence 1.0)."""
    by_id = {row.get("category_id"): row for row in shelf_rows if row.get("category_id") is not None}
    by_name = {normalize_category_key(str(row.get("category_name") or "")): row for row in shelf_rows}

    snapped: list[dict[str, Any]] = []
    for correction in corrections:
        cat_id = correction.get("category_id")
        name = correction.get("category_name") or ""
        row = by_id.get(cat_id) if cat_id is not None else None
        if row is None:
            row = by_name.get(normalize_category_key(name), {})
        band = (correction.get("band") or row.get("band") or "low").lower()
        current_qty = correction.get("estimated_qty")
        if current_qty is None:
            current_qty = row.get("estimated_qty")
        qty = band_to_qty(band, current_qty)
        snapped.append(
            {
                "category_id": cat_id if cat_id is not None else row.get("category_id"),
                "category_name": name or row.get("category_name"),
                "category_emoji": correction.get("category_emoji") or row.get("category_emoji") or "📦",
                "band": band,
                "estimated_qty": qty,
                "source": "volunteer_correction",
                "confidence": 1.0,
            }
        )
    return snapped
