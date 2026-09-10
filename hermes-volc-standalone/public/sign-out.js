// Clear the server session before leaving any signed-in view.
export async function signOut({ fetchFn = globalThis.fetch, beforeLeave = () => {} } = {}) {
  let response;
  try {
    response = await fetchFn('/api/student/logout', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: '{}',
      signal: AbortSignal.timeout(10000),
    });
  } catch { throw new Error('Could not sign out. Please try again.'); }
  if (!response.ok) throw new Error('Could not sign out. Please try again.');
  beforeLeave();
  location.replace('/?login=1');
}
