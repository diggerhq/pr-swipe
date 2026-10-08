// Vercel function for every /api route; vercel.json rewrites /api/* here.
import { handleApi } from "../web/handler.mjs";

export default async function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (!(await handleApi(req, res, url))) {
    res.statusCode = 404;
    res.end("Not found");
  }
}
