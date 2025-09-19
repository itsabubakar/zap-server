export const ok = (res, data = {}) => res.json(data);
export const created = (res, data = {}) => res.status(201).json(data);
export const badRequest = (res, msg = "Bad request") =>
  res.status(400).json({ error: msg });
export const unauthorized = (res, msg = "Unauthorized") =>
  res.status(401).json({ error: msg });
export const conflict = (res, msg = "Conflict") =>
  res.status(409).json({ error: msg });
export const serverError = (res, e) => {
  console.error(e);
  return res.status(500).json({ error: "Server error" });
};
