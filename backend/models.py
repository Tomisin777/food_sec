from pydantic import BaseModel, Field
from typing import List, Optional, Any
from uuid import UUID

class PantryBase(BaseModel):
    id: UUID
    name: str
    address: str
    neighborhood: Optional[str] = None
    lat: float
    lng: float
    phone: Optional[str] = None
    distribution_model: Optional[str] = None
    hours: Optional[Any] = None
    requires_id: Optional[bool] = False
    allows_walkins: Optional[bool] = True
    languages: Optional[List[str]] = None
    notes: Optional[str] = None

class ShelfItem(BaseModel):
    category_name: str
    category_emoji: str
    band: str
    minutes_ago: Optional[int] = None
    confidence: Optional[float] = None
    source: Optional[str] = None

class PantryWithShelf(PantryBase):
    shelf_items: List[ShelfItem]
    distance_miles: Optional[float] = None
    walk_minutes: Optional[int] = None

class OrderItem(BaseModel):
    category_id: Optional[int] = None
    category_name: Optional[str] = None
    quantity: float

class CheckInRequest(BaseModel):
    pantry_id: UUID
    household_size: int = Field(..., ge=1, le=20)
    order_items: Optional[List[OrderItem]] = None

class CorrectionItem(BaseModel):
    category_id: Optional[int] = None
    category_name: Optional[str] = None
    band: str
    estimated_qty: Optional[float] = None

class CorrectionRequest(BaseModel):
    pantry_id: UUID
    corrections: List[CorrectionItem]

class DistributionUpdate(BaseModel):
    distribution_model: str

class IntakeResult(BaseModel):
    items: List[ShelfItem]

class DepletionResult(BaseModel):
    category_id: Optional[int] = None
    category_name: str
    category_emoji: Optional[str] = None
    depleted: float
    remaining_qty: float
    band: str
    previous_band: Optional[str] = None
    confidence: float
    source: str = "prediction"

class CheckInResult(BaseModel):
    status: str = "success"
    household_size: int
    distribution_model: str
    estimated_lbs: float
    depletions: List[DepletionResult]
    families_served_today: int
    people_served_today: int
