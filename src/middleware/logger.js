import morgan from "morgan";
import { randomUUID } from "crypto";

// attach a request id so you can trace a single request across logs
export function requestId(req, res, next) {
  req.id = req.headers["x-request-id"] || randomUUID();
  res.setHeader("x-request-id", req.id);
  next();
}

// expose tokens for morgan
morgan.token("id", (req) => req.id);
morgan.token("user", (req) => (req.user?.sub ? String(req.user.sub) : "-")); // works if you attach req.user in auth

// choose a format (dev = concise; combined = Apache-style)
const format =
  process.env.NODE_ENV === "production"
    ? ':id :remote-addr - :method :url HTTP/:http-version :status :res[content-length] ":referrer" ":user-agent" :response-time ms user=:user'
    : ":id :method :url :status :res[content-length] - :response-time ms user=:user";

export const httpLogger = morgan(format, {
  skip: (req) => req.path === "/health",
});
