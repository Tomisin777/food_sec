from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query
from fastapi.responses import StreamingResponse
from models import (
    CheckInRequest,
    CheckInResult,
    CorrectionRequest,
    DepletionResult,
    DistributionUpdate,
    IntakeResult,
    ShelfItem,
)
from db import get_db_conn
from estimator import estimate_checkin, qty_to_band, qty_from_band, snap_corrections
from report import build_monthly_report_csv, month_bounds
import asyncpg
from uuid import UUID
import json

router = APIRouter(prefix="/api/inventory", tags=["inventory"])

VALID_MODELS = {"pre_packed", "list", "client_choice"}
VALID_BANDS = {"plenty", "low", "out"}


def _dump(model) -> dict:
    return model.model_dump() if hasattr(model, "model_dump") else model.dict()


async def _pantry_or_404(conn: asyncpg.Connection, pantry_id: UUID) -> asyncpg.Record:
    row = await conn.fetchrow(
        "SELECT id, name, distribution_model FROM pantries WHERE id = $1",
        pantry_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Pantry not found")
    return row


async def _shelf_rows(conn: asyncpg.Connection, pantry_id: UUID) -> list[dict]:
    """Latest shelf + allocation rate per category this pantry carries."""
    rows = await conn.fetch(
        """
        SELECT
            fc.id AS category_id,
            fc.name AS category_name,
            fc.emoji AS category_emoji,
            ls.band,
            ls.estimated_qty,
            ls.source,
            ls.confidence,
            ls.minutes_ago,
            COALESCE(pc.lbs_per_person, 2.0) AS lbs_per_person
        FROM food_categories fc
        LEFT JOIN pantry_categories pc
            ON pc.category_id = fc.id AND pc.pantry_id = $1
        LEFT JOIN latest_shelf ls
            ON ls.category_id = fc.id AND ls.pantry_id = $1
        WHERE pc.pantry_id = $1 OR ls.pantry_id = $1
        ORDER BY fc.id
        """,
        pantry_id,
    )
    if rows:
        return [dict(r) for r in rows]

    # New pantry with no junction/shelf rows yet — seed from default categories.
    defaults = await conn.fetch(
        "SELECT id AS category_id, name AS category_name, emoji AS category_emoji FROM food_categories WHERE is_default = true ORDER BY id"
    )
    return [
        {
            **dict(r),
            "band": "plenty",
            "estimated_qty": 30,
            "source": "manual",
            "confidence": 1.0,
            "minutes_ago": 0,
            "lbs_per_person": 2.0,
        }
        for r in defaults
    ]


async def _today_counts(conn: asyncpg.Connection, pantry_id: UUID) -> tuple[int, int]:
    row = await conn.fetchrow(
        """
        SELECT COUNT(*)::int AS households,
               COALESCE(SUM(household_size), 0)::int AS people
        FROM check_ins
        WHERE pantry_id = $1 AND time >= CURRENT_DATE
        """,
        pantry_id,
    )
    return int(row["households"]), int(row["people"])


def _serialize_depletions(depletions: list[dict]) -> list[DepletionResult]:
    return [
        DepletionResult(
            category_id=d.get("category_id"),
            category_name=d.get("category_name") or "",
            category_emoji=d.get("category_emoji"),
            depleted=d["depleted"],
            remaining_qty=d["remaining_qty"],
            band=d["band"],
            previous_band=d.get("previous_band"),
            confidence=d["confidence"],
            source="prediction",
        )
        for d in depletions
    ]


@router.post("/checkin", response_model=CheckInResult)
async def checkin(request: CheckInRequest, conn: asyncpg.Connection = Depends(get_db_conn)):
    """Log a household visit and deplete estimated shelf quantities."""
    if request.household_size < 1 or request.household_size > 20:
        raise HTTPException(status_code=400, detail="household_size must be between 1 and 20")

    pantry = await _pantry_or_404(conn, request.pantry_id)
    model = pantry["distribution_model"] or "client_choice"
    shelf = await _shelf_rows(conn, request.pantry_id)

    order_payload = None
    if request.order_items:
        order_payload = [_dump(item) for item in request.order_items]

    estimate = estimate_checkin(
        distribution_model=model,
        household_size=request.household_size,
        shelf_rows=shelf,
        order_items=order_payload,
    )

    items_json = json.dumps(
        [
            {
                "category_id": d.get("category_id"),
                "category_name": d.get("category_name"),
                "depleted": d["depleted"],
            }
            for d in estimate["depletions"]
            if d["depleted"] > 0
        ]
    )

    async with conn.transaction():
        await conn.execute(
            """
            INSERT INTO check_ins (time, pantry_id, household_size, distribution_model, estimated_lbs, items)
            VALUES (NOW(), $1, $2, $3::distribution_model, $4, $5::jsonb)
            """,
            request.pantry_id,
            request.household_size,
            estimate["distribution_model"],
            estimate["estimated_lbs"],
            items_json,
        )
        await conn.executemany(
            """
            INSERT INTO shelf_state (time, pantry_id, category_id, band, estimated_qty, source, confidence)
            VALUES (NOW(), $1, $2, $3::stock_band, $4, 'prediction'::update_source, $5)
            """,
            [
                (
                    request.pantry_id,
                    d["category_id"],
                    d["band"],
                    d["remaining_qty"],
                    d["confidence"],
                )
                for d in estimate["depletions"]
                if d.get("category_id") is not None
            ],
        )

    households, people = await _today_counts(conn, request.pantry_id)
    return CheckInResult(
        household_size=request.household_size,
        distribution_model=estimate["distribution_model"],
        estimated_lbs=estimate["estimated_lbs"],
        depletions=_serialize_depletions(estimate["depletions"]),
        families_served_today=households,
        people_served_today=people,
    )


@router.post("/correction")
async def correction(request: CorrectionRequest, conn: asyncpg.Connection = Depends(get_db_conn)):
    """Volunteer closing check: snap estimates to ground truth and reset confidence to 1.0."""
    await _pantry_or_404(conn, request.pantry_id)
    if not request.corrections:
        raise HTTPException(status_code=400, detail="corrections cannot be empty")

    for item in request.corrections:
        if item.band not in VALID_BANDS:
            raise HTTPException(status_code=400, detail=f"Invalid band: {item.band}")

    shelf = await _shelf_rows(conn, request.pantry_id)
    snapped = snap_corrections([_dump(c) for c in request.corrections], shelf)

    # Resolve missing category ids by name.
    name_to_id = {str(r["category_name"]).lower(): r["category_id"] for r in shelf if r.get("category_id")}
    rows = []
    for item in snapped:
        cat_id = item.get("category_id")
        if cat_id is None and item.get("category_name"):
            cat_id = name_to_id.get(str(item["category_name"]).lower())
        if cat_id is None:
            continue
        rows.append((request.pantry_id, cat_id, item["band"], item["estimated_qty"]))

    if not rows:
        raise HTTPException(status_code=400, detail="No matching categories to correct")

    await conn.executemany(
        """
        INSERT INTO shelf_state (time, pantry_id, category_id, band, estimated_qty, source, confidence)
        VALUES (NOW(), $1, $2, $3::stock_band, $4, 'volunteer_correction'::update_source, 1.0)
        """,
        rows,
    )
    return {
        "status": "success",
        "source": "volunteer_correction",
        "confidence": 1.0,
        "updated": [
            {
                "category_id": cat_id,
                "band": band,
                "estimated_qty": qty,
                "source": "volunteer_correction",
                "confidence": 1.0,
            }
            for (_, cat_id, band, qty) in rows
        ],
    }


@router.post("/intake", response_model=IntakeResult)
async def intake(
    pantry_id: UUID = Form(...),
    photo: UploadFile = File(...),
    conn: asyncpg.Connection = Depends(get_db_conn),
):
    """Accept a photo, process with Gemini vision (mocked for now), insert shelf_state."""
    mock_items = [
        {"category_id": 1, "band": "plenty", "confidence": 0.95},
        {"category_id": 2, "band": "low", "confidence": 0.85},
    ]

    query = """
        INSERT INTO shelf_state (time, pantry_id, category_id, band, source, confidence)
        VALUES (NOW(), $1, $2, $3, 'intake_photo', $4)
    """
    args = [(pantry_id, item["category_id"], item["band"], item["confidence"]) for item in mock_items]
    await conn.executemany(query, args)

    shelf_items = []
    for item in mock_items:
        cat = await conn.fetchrow("SELECT name, emoji FROM food_categories WHERE id = $1", item["category_id"])
        if cat:
            shelf_items.append(
                ShelfItem(
                    category_name=cat["name"],
                    category_emoji=cat["emoji"],
                    band=item["band"],
                    confidence=item["confidence"],
                    source="intake_photo",
                    minutes_ago=0,
                )
            )

    return IntakeResult(items=shelf_items)


@router.get("/{pantry_id}/today")
async def get_today_stats(pantry_id: UUID, conn: asyncpg.Connection = Depends(get_db_conn)):
    """Today's check-in count and individuals served."""
    await _pantry_or_404(conn, pantry_id)
    households, people = await _today_counts(conn, pantry_id)
    return {
        "check_in_count": households,
        "households_served": households,
        "total_households": people,
        "people_served": people,
    }


@router.get("/{pantry_id}/shelf")
async def get_shelf(pantry_id: UUID, conn: asyncpg.Connection = Depends(get_db_conn)):
    """Latest estimated shelf state for the operator closing check."""
    pantry = await _pantry_or_404(conn, pantry_id)
    shelf = await _shelf_rows(conn, pantry_id)
    return {
        "pantry_id": str(pantry_id),
        "name": pantry["name"],
        "distribution_model": pantry["distribution_model"],
        "items": [
            {
                "category_id": row["category_id"],
                "category_name": row["category_name"],
                "category_emoji": row["category_emoji"],
                "band": row.get("band") or qty_to_band(qty_from_band(row.get("band"), row.get("estimated_qty"))),
                "estimated_qty": float(qty_from_band(row.get("band"), row.get("estimated_qty"))),
                "confidence": float(row["confidence"]) if row.get("confidence") is not None else None,
                "source": row.get("source"),
                "minutes_ago": row.get("minutes_ago"),
                "lbs_per_person": float(row["lbs_per_person"]) if row.get("lbs_per_person") is not None else 2.0,
            }
            for row in shelf
        ],
    }


@router.get("/{pantry_id}/report")
async def monthly_report(
    pantry_id: UUID,
    year: int = Query(..., ge=2000, le=2100),
    month: int = Query(..., ge=1, le=12),
    conn: asyncpg.Connection = Depends(get_db_conn),
):
    """TEFAP / Maryland Food Bank monthly compliance CSV."""
    pantry = await _pantry_or_404(conn, pantry_id)
    start, end = month_bounds(year, month)

    checkins = await conn.fetch(
        """
        SELECT time, household_size, estimated_lbs, distribution_model, items
        FROM check_ins
        WHERE pantry_id = $1
          AND time >= $2::date
          AND time < ($3::date + INTERVAL '1 day')
        ORDER BY time
        """,
        pantry_id,
        start,
        end,
    )
    allocations = await conn.fetch(
        """
        SELECT pc.lbs_per_person
        FROM pantry_categories pc
        WHERE pc.pantry_id = $1
        """,
        pantry_id,
    )
    default_pack = sum(float(r["lbs_per_person"]) for r in allocations) if allocations else 10.3
    csv_body = build_monthly_report_csv(
        pantry_name=pantry["name"],
        pantry_id=str(pantry_id),
        year=year,
        month=month,
        current_model=pantry["distribution_model"] or "client_choice",
        checkins=[dict(r) for r in checkins],
        default_pack_lbs=default_pack,
    )
    filename = f"tefap-report-{start.strftime('%Y-%m')}-{pantry_id}.csv"
    return StreamingResponse(
        iter([csv_body]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.patch("/{pantry_id}/distribution")
async def update_distribution(
    pantry_id: UUID,
    request: DistributionUpdate,
    conn: asyncpg.Connection = Depends(get_db_conn),
):
    """Persist the pantry's distribution style (pre_packed | list | client_choice)."""
    model = (request.distribution_model or "").lower()
    if model not in VALID_MODELS:
        raise HTTPException(
            status_code=400,
            detail="distribution_model must be pre_packed, list, or client_choice",
        )
    await _pantry_or_404(conn, pantry_id)
    await conn.execute(
        "UPDATE pantries SET distribution_model = $1::distribution_model WHERE id = $2",
        model,
        pantry_id,
    )
    return {"status": "success", "pantry_id": str(pantry_id), "distribution_model": model}
