import jwt from "jsonwebtoken";

export function requireAuth(req, res, next) {
  // Example: Authorization: Bearer <token>
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  try {
    // Replace with your real JWT secret/verification
    const payload = jwt.verify(token, process.env.JWT_SECRET || "dev-secret");
    // Expect payload like { sub: 'userId', type: 'admin'|'registrar'|'user' }
    req.user = {
      id: payload.sub,
      type: payload.type,
      institution: payload.institution_name,
    };
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

export function allowRoles(...roles) {
  return (req, res, next) => {
    if (!req.user?.type) return res.status(403).json({ error: "Forbidden" });
    if (!roles.includes(req.user.type)) {
      return res.status(403).json({ error: "Insufficient type" });
    }
    next();
  };
}
