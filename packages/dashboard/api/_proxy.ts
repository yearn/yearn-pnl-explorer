export const config = {
  runtime: "edge",
};

function getProxyTarget(): string | null {
  const maybeProcess = globalThis as typeof globalThis & {
    process?: {
      env?: Record<string, string | undefined>;
    };
  };

  return maybeProcess.process?.env?.API_PROXY_TARGET || null;
}

function buildUpstreamUrl(requestUrl: URL, proxyTarget: string): URL {
  const base = new URL(proxyTarget);
  const upstream = new URL(base.toString());
  const basePath = base.pathname.replace(/\/$/, "");
  upstream.pathname = `${basePath}${requestUrl.pathname}`;
  upstream.search = requestUrl.search;
  return upstream;
}

function forwardHeaders(request: Request): Headers {
  const headers = new Headers();
  const accept = request.headers.get("accept");
  const contentType = request.headers.get("content-type");

  if (accept) headers.set("accept", accept);
  if (contentType) headers.set("content-type", contentType);

  return headers;
}

export async function proxyRequest(request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: {
        allow: "GET, HEAD",
      },
    });
  }

  const proxyTarget = getProxyTarget();
  if (!proxyTarget) {
    return new Response("Missing API_PROXY_TARGET", { status: 500 });
  }

  const incomingUrl = new URL(request.url);
  const upstreamUrl = buildUpstreamUrl(incomingUrl, proxyTarget);
  const upstreamResponse = await fetch(upstreamUrl, {
    method: request.method,
    headers: forwardHeaders(request),
    redirect: "follow",
  });

  const headers = new Headers(upstreamResponse.headers);
  headers.set("cache-control", "no-store");

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}
