type ProxyRequest = {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
};

type ProxyResponse = {
  end: (body?: string) => void;
  setHeader: (name: string, value: string) => void;
  status: (code: number) => ProxyResponse;
};

function readHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function getProxyTarget(): string | null {
  if (typeof process === "undefined") return null;
  return process.env.API_PROXY_TARGET || null;
}

function buildUpstreamUrl(requestUrl: string, proxyTarget: string): URL {
  const incomingUrl = new URL(requestUrl, "https://dashboard.local");
  const base = new URL(proxyTarget);
  const upstream = new URL(base.toString());
  const basePath = base.pathname.replace(/\/$/, "");
  upstream.pathname = `${basePath}${incomingUrl.pathname}`;
  upstream.search = incomingUrl.search;
  return upstream;
}

function buildForwardHeaders(request: ProxyRequest): Headers {
  const headers = new Headers();
  const accept = readHeader(request.headers?.accept);
  const contentType = readHeader(request.headers?.["content-type"]);

  if (accept) headers.set("accept", accept);
  if (contentType) headers.set("content-type", contentType);

  return headers;
}

function sendText(response: ProxyResponse, status: number, body: string): void {
  response.status(status);
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(body);
}

export async function proxyRequest(request: ProxyRequest, response: ProxyResponse): Promise<void> {
  try {
    const method = request.method || "GET";
    if (method !== "GET" && method !== "HEAD") {
      response.setHeader("allow", "GET, HEAD");
      sendText(response, 405, "Method Not Allowed");
      return;
    }

    const proxyTarget = getProxyTarget();
    if (!proxyTarget) {
      sendText(response, 500, "Missing API_PROXY_TARGET");
      return;
    }

    const upstreamUrl = buildUpstreamUrl(request.url || "/", proxyTarget);
    const upstreamResponse = await fetch(upstreamUrl, {
      method,
      headers: buildForwardHeaders(request),
      redirect: "follow",
    });

    upstreamResponse.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower === "content-length" || lower === "transfer-encoding") return;
      response.setHeader(key, value);
    });
    response.setHeader("cache-control", "no-store");
    response.status(upstreamResponse.status);

    if (method === "HEAD") {
      response.end();
      return;
    }

    response.end(await upstreamResponse.text());
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    sendText(response, 500, `Proxy invocation failed\n${message}`);
  }
}
