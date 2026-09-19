import { NextResponse } from 'next/server';
import { tryBackend } from '@/lib/backendProxy';
import { getPantryState } from '@/lib/operatorStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, context: { params: Promise<{ pantryId: string }> }) {
  const { pantryId } = await context.params;
  const backend = await tryBackend(`/api/inventory/${pantryId}/shelf`);
  if (backend) {
    return new NextResponse(await backend.text(), {
      status: backend.status,
      headers: { 'Content-Type': backend.headers.get('Content-Type') || 'application/json' },
    });
  }
  const pantry = getPantryState(pantryId);
  return NextResponse.json({
    pantry_id: pantry.pantry_id,
    name: pantry.name,
    distribution_model: pantry.distribution_model,
    items: pantry.shelf,
  });
}
