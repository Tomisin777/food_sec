const BACKEND_CANDIDATES = ['http://127.0.0.1:8000', 'http://localhost:8000'];

export async function tryBackend(
  path: string,
  init?: RequestInit
): Promise<Response | null> {
  for (const origin of BACKEND_CANDIDATES) {
    try {
      const res = await fetch(`${origin}${path}`, {
        ...init,
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) return res;
    } catch {
      // FastAPI is optional in the frontend-only demo.
    }
  }
  return null;
}
