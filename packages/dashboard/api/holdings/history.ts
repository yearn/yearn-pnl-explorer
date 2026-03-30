export { config } from "../_proxy";
import { proxyRequest } from "../_proxy";

export default async function handler(request: Request): Promise<Response> {
  return proxyRequest(request);
}
