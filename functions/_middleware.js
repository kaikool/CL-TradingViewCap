// CORS + preflight cho toàn bộ routes
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    },
  });
}

export async function onRequest(context) {
  const resp = await context.next();
  const hdr = new Headers(resp.headers);
  hdr.set("Access-Control-Allow-Origin", "*");
  return new Response(resp.body, { status: resp.status, headers: hdr });
}
