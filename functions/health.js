export const onRequestGet = async () => {
  return new Response(JSON.stringify({ ok: true, time: new Date().toISOString() }), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
