// Cloudflare Pages Function
// 경로: /api/storage  (GET, POST, DELETE)
//
// 이 파일이 동작하려면 Cloudflare Pages 프로젝트에 "DASHBOARD_KV"라는 이름의
// KV Namespace 바인딩이 연결되어 있어야 합니다. (README의 5단계 참고)
//
// 사용법:
//   GET    /api/storage?key=dashboard:campaign-budgets
//   POST   /api/storage   body: { key, value }
//   DELETE /api/storage?key=dashboard:campaign-budgets

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders() });
}

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const key = url.searchParams.get("key");
    if (!key) return jsonResponse({ error: "key 파라미터가 필요합니다." }, 400);

    if (!env.DASHBOARD_KV) {
      return jsonResponse({ error: "KV Namespace(DASHBOARD_KV)가 바인딩되지 않았습니다. Cloudflare Pages 설정을 확인하세요." }, 500);
    }

    const value = await env.DASHBOARD_KV.get(key);
    if (value === null) {
      return jsonResponse({ value: null });
    }
    return jsonResponse({ value });
  } catch (e) {
    return jsonResponse({ error: String(e) }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DASHBOARD_KV) {
      return jsonResponse({ error: "KV Namespace(DASHBOARD_KV)가 바인딩되지 않았습니다." }, 500);
    }
    const body = await request.json();
    const { key, value } = body;
    if (!key || value === undefined) {
      return jsonResponse({ error: "key와 value가 모두 필요합니다." }, 400);
    }
    await env.DASHBOARD_KV.put(key, value);
    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonResponse({ error: String(e) }, 500);
  }
}

export async function onRequestDelete({ request, env }) {
  try {
    if (!env.DASHBOARD_KV) {
      return jsonResponse({ error: "KV Namespace(DASHBOARD_KV)가 바인딩되지 않았습니다." }, 500);
    }
    const url = new URL(request.url);
    const key = url.searchParams.get("key");
    if (!key) return jsonResponse({ error: "key 파라미터가 필요합니다." }, 400);

    await env.DASHBOARD_KV.delete(key);
    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonResponse({ error: String(e) }, 500);
  }
}
