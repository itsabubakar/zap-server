import bcrypt from "bcrypt";
import sql from "../db/db.js";
import { signToken } from "../utils/jwt.js";
import {
  ok,
  created,
  badRequest,
  conflict,
  serverError,
} from "../utils/responses.js";

export async function register(req, res) {
  try {
    const {
      institutionName,
      fullName,
      userType,
      email,
      password,
      institutionLogo,
    } = req.body || {};
    if (!institutionName || !fullName || !userType || !email || !password) {
      return res.status(400).json({
        error: "institutionName, fullName, userType, email, password required",
      });
    }

    const existing =
      await sql`select 1 from users where lower(email) = lower(${email})`;
    if (existing.length)
      return res.status(409).json({ error: "Email already in use" });

    const hash = await bcrypt.hash(password, 12);
    const [user] = await sql`
      insert into users (institution_name, full_name, user_type, email, password_hash, institution_logo)
      values (${institutionName}, ${fullName}, ${userType}, ${email}, ${hash}, ${
      institutionLogo ?? null
    })
      returning
        id,
        institution_name as "institutionName",
        full_name as "fullName",
        user_type as "type",
        institution_logo,
        email,
        created_at as "createdAt"
    `;

    // include role/type in token if you like
    const token = signToken({
      sub: user.id,
      email: user.email,
      type: user.type,
      institution_name: user.institutionName,
    });
    return res.status(201).json({ token, user });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
}

export async function login(req, res) {
  try {
    const { email, password } = req.body || {};
    const [row] =
      await sql`select * from users where lower(email) = lower(${email})`;
    if (!row) return res.status(400).json({ error: "Invalid credentials" });

    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) return res.status(400).json({ error: "Invalid credentials" });

    const user = {
      id: row.id,
      institutionName: row.institution_name,
      fullName: row.full_name,
      type: row.user_type,
      institution_logo: row.institution_logo,
      email: row.email,
      createdAt: row.created_at,
    };

    const token = signToken({
      sub: user.id,
      email: user.email,
      type: user.type,
      institution_name: user.institutionName,
    });
    return res.json({ token, user });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
}

export async function me(req, res) {
  try {
    const userId = req.user?.sub;
    const { rows } = await sql.query(
      "select id, email, created_at from users where id = $1",
      [userId]
    );
    return ok(res, { user: rows[0] || null });
  } catch (e) {
    return serverError(res, e);
  }
}
