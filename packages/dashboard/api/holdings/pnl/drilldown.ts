import { proxyRequest } from "../../_proxy";

export default async function handler(request: any, response: any): Promise<void> {
  return proxyRequest(request, response);
}
