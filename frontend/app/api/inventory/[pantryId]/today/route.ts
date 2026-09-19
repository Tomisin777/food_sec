import { NextResponse } from 'next/server';
import { tryBackend } from '@/lib/backendProxy';
import { todayStats } from '@/lib/operatorStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, context: { params: Promise<{ pantryId: string }> }) {
  const { pantryId } = await context.params;
  const backend = await tryBackend(`/api/inventory/${pantryId}/today`);
  if (backend) {
    return new NextResponse(await backend.text(), {
      status: backend.status,
      headers: { 'Content-Type': backend.headers.get('Content-Type') || 'application/json' },
    });
  }
  return NextResponse.json(todayStats(pantryId));
}
