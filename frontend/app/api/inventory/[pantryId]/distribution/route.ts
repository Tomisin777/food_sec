import { NextRequest, NextResponse } from 'next/server';
import { tryBackend } from '@/lib/backendProxy';
import { DistributionModel } from '@/lib/estimator';
import { setDistributionModel } from '@/lib/operatorStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID = new Set(['pre_packed', 'list', 'client_choice']);

export async function PATCH(req: NextRequest, context: { params: Promise<{ pantryId: string }> }) {
  const { pantryId } = await context.params;
  const body = await req.json();
  const model = String(body.distribution_model || '').toLowerCase() as DistributionModel;
  if (!VALID.has(model)) {
    return NextResponse.json(
      { detail: 'distribution_model must be pre_packed, list, or client_choice' },
      { status: 400 }
    );
  }

  const backend = await tryBackend(`/api/inventory/${pantryId}/distribution`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ distribution_model: model }),
  });
  if (backend) {
    return new NextResponse(await backend.text(), {
      status: backend.status,
      headers: { 'Content-Type': backend.headers.get('Content-Type') || 'application/json' },
    });
  }

  const pantry = setDistributionModel(pantryId, model);
  return NextResponse.json({
    status: 'success',
    pantry_id: pantry.pantry_id,
    distribution_model: pantry.distribution_model,
  });
}
