import { NextRequest, NextResponse } from 'next/server';
import { tryBackend } from '@/lib/backendProxy';
import { recordCheckIn } from '@/lib/operatorStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const pantryId = body.pantry_id as string;
  const householdSize = Number(body.household_size);
  const orderItems = body.order_items;

  if (!pantryId || !householdSize || householdSize < 1 || householdSize > 20) {
    return NextResponse.json({ detail: 'pantry_id and household_size (1-20) are required' }, { status: 400 });
  }

  const backend = await tryBackend('/api/inventory/checkin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (backend) {
    return new NextResponse(await backend.text(), {
      status: backend.status,
      headers: { 'Content-Type': backend.headers.get('Content-Type') || 'application/json' },
    });
  }

  const result = recordCheckIn(pantryId, householdSize, orderItems);
  return NextResponse.json({
    status: 'success',
    household_size: result.estimate.household_size,
    distribution_model: result.estimate.distribution_model,
    estimated_lbs: result.estimate.estimated_lbs,
    depletions: result.estimate.depletions,
    families_served_today: result.families_served_today,
    people_served_today: result.people_served_today,
  });
}
