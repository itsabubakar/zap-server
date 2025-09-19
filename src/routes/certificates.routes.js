import express from "express";
import multer from "multer";
import xlsx from "xlsx";
import { v4 as uuidv4 } from "uuid";
import QRCode from "qrcode";
import PDFDocument from "pdfkit";
import dayjs from "dayjs";

import fs from "fs/promises";

// if your renderPDF already exists, keep it — just returns Buffer
/** Fetch a URL or local path into a Buffer. Returns null on failure. */
async function fetchBuffer(url, { timeoutMs = 8000 } = {}) {
  try {
    if (!url) return null;

    // If it's a local file path
    if (!/^https?:\/\//i.test(url)) {
      return await fs.readFile(url);
    }

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);

    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);

    if (!res.ok) return null;
    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
  } catch {
    return null;
  }
}

/**
 * Render one certificate PDF into a Buffer.
 * @param {{
 *   institution_name: string,
 *   full_name: string,
 *   program: string,
 *   certificate: string,
 *   cgpa: string,
 *   certificate_id: string,
 *   verify_url: string,
 *   issue_date: string,
 *   logo_url?: string,
 *   image_url?: string,
 * }} payload
 * @returns {Promise<Buffer>}
 */
async function renderCertificatePDF(payload) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        layout: "landscape",
        margins: { top: 50, bottom: 50, left: 50, right: 50 },
      });

      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));

      // ----- Top logo (centered) -----
      if (payload.logo_url) {
        const logoBuf = await fetchBuffer(payload.logo_url);
        if (logoBuf) {
          const logoW = 110;
          const logoX = (doc.page.width - logoW) / 2;
          doc.image(logoBuf, logoX, 28, { width: logoW });
          doc.moveDown(5);
        }
      }

      // ----- Institution header -----
      doc
        .font("Helvetica-Bold")
        .fontSize(32)
        .text(payload.institution_name || "Institution", { align: "center" });

      // Decorative line
      const lineY = doc.y + 8;
      doc
        .moveTo(100, lineY)
        .lineTo(doc.page.width - 100, lineY)
        .stroke();
      doc.moveDown(2);

      // Title
      doc
        .font("Helvetica-Bold")
        .fontSize(24)
        .text("Certificate of Completion", { align: "center" });
      doc.moveDown(1.2);

      // ----- Student photo (circle, left) -----
      if (payload.image_url) {
        const studentBuf = await fetchBuffer(payload.image_url);
        if (studentBuf) {
          const size = 140;
          const x = 70;
          const y = lineY + 50;

          doc.save();
          doc.circle(x + size / 2, y + size / 2, size / 2).clip();
          doc.image(studentBuf, x, y, { width: size, height: size });
          doc.restore();

          // border ring
          doc
            .circle(x + size / 2, y + size / 2, size / 2)
            .lineWidth(2)
            .strokeColor("#999")
            .stroke();
        }
      }

      // ----- Main content -----
      doc.moveDown(1.5);
      doc
        .font("Helvetica-Bold")
        .fontSize(28)
        .text(payload.full_name || "Recipient Name", { align: "center" });

      doc.moveDown(0.6);
      if (payload.program) {
        doc
          .font("Helvetica")
          .fontSize(18)
          .text(`has successfully completed the program: ${payload.program}`, {
            align: "center",
          });
      }

      if (payload.certificate) {
        doc.moveDown(0.4);
        doc
          .font("Helvetica")
          .fontSize(18)
          .text(`Awarded: ${payload.certificate}`, { align: "center" });
      }

      if (payload.cgpa) {
        doc.moveDown(0.4);
        doc
          .font("Helvetica")
          .fontSize(18)
          .text(`CGPA: ${payload.cgpa}`, { align: "center" });
      }

      doc.moveDown(1.2);
      doc
        .font("Helvetica-Oblique")
        .fontSize(14)
        .text(`Issued on: ${payload.issue_date}`, { align: "center" });
      doc.text(`Certificate ID: ${payload.certificate_id}`, {
        align: "center",
      });

      // ----- QR code bottom-right -----
      if (payload.verify_url) {
        const qrDataUrl = await QRCode.toDataURL(payload.verify_url);
        const qrImg = Buffer.from(qrDataUrl.split(",")[1], "base64");
        const qrSize = 120;
        const qrX = doc.page.width - qrSize - 60;
        const qrY = doc.page.height - qrSize - 60;
        doc.image(qrImg, qrX, qrY, { width: qrSize });
        doc
          .font("Helvetica")
          .fontSize(10)
          .fillColor("#666")
          .text("Scan to verify", qrX, qrY - 16, {
            width: qrSize,
            align: "center",
          });
        doc.fillColor("black");
      }

      // ----- Signature lines -----
      const sigY = doc.page.height - 110;
      doc
        .font("Helvetica")
        .fontSize(12)
        .text("_____________________", 120, sigY);
      doc.text("Dean", 170, sigY + 18);

      doc.text("_____________________", doc.page.width / 2, sigY);
      doc.text("Registrar", doc.page.width / 2 + 45, sigY + 18);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
const upload = multer({ storage: multer.memoryStorage() });
const router = express.Router();

/** Upload a pdf buffer to Supabase Storage and return { path, publicUrl? } */
async function uploadPdfToStorage(
  buffer,
  objectPath,
  { publicBucket = true } = {}
) {
  const { error: upErr } = await supabase.storage
    .from("certificates")
    .upload(objectPath, buffer, {
      contentType: "application/pdf",
      upsert: true,
    });
  if (upErr) throw upErr;

  if (publicBucket) {
    const { data } = supabase.storage
      .from("certificates")
      .getPublicUrl(objectPath);
    return { path: objectPath, url: data.publicUrl };
  }
  return { path: objectPath, url: null };
}

// POST /certificates/generate  (returns JSON, not a file download)
router.post(
  "/generate",
  requireAuth,
  allowRoles("admin", "registrar"),
  upload.single("file"), // Excel file field name: "file"
  async (req, res) => {
    try {
      const institutionName = (req.body.institution_name || "").trim();
      const logoUrl = (req.body.logo_url || "").trim(); // optional
      if (!institutionName)
        return res.status(400).json({ error: "institution_name is required" });
      if (!req.file)
        return res.status(400).json({ error: "Excel file (file) is required" });

      // parse Excel
      const wb = xlsx.read(req.file.buffer, { type: "buffer" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = xlsx.utils.sheet_to_json(ws, { defval: "" });
      if (!rows.length)
        return res.status(400).json({ error: "No rows in Excel" });

      const required = ["Full Name", "Program", "Certificate", "CGPA"];
      const hasCols = required.every((c) => c in rows[0]);
      if (!hasCols)
        return res
          .status(400)
          .json({ error: `Missing required columns: ${required.join(", ")}` });

      const issueDate = dayjs().format("YYYY-MM-DD");
      const publicBase =
        process.env.PUBLIC_BASE_URL || "https://zap-server-z2ra.onrender.com";
      const createdBy = req.user?.id || null;

      const inserted = [];

      for (const row of rows) {
        const certificateId = uuidv4();
        const verifyUrl = `${publicBase}/certificates/verify/${certificateId}`;

        const payload = {
          institution_name: institutionName,
          full_name: String(row["Full Name"] || "").trim(),
          program: String(row["Program"] || "").trim(),
          certificate: String(row["Certificate"] || "").trim(),
          cgpa: String(row["CGPA"] || "").trim(),
          image_url: String(row["Image Url"] || "").trim(),
          logo_url: logoUrl,
          certificate_id: certificateId,
          verify_url: verifyUrl,
          issue_date: issueDate,
        };

        // generate PDF buffer
        const pdfBuf = await renderCertificatePDF(payload);

        // upload to storage
        const safeName =
          payload.full_name.replace(/[\/\\:*?"<>|]/g, "-") || "recipient";
        const objectPath = `certificates/${certificateId}/${safeName}.pdf`;
        const { path: pdf_path, url: pdf_url } = await uploadPdfToStorage(
          pdfBuf,
          objectPath,
          {
            publicBucket: true, // set false if bucket is private
          }
        );

        // insert metadata row
        const { data, error } = await supabase
          .from("certificates")
          .insert({
            certificate_id: certificateId,
            full_name: payload.full_name,
            program: payload.program,
            certificate: payload.certificate,
            cgpa: payload.cgpa,
            institution_name: payload.institution_name,
            image_url: payload.image_url || null,
            logo_url: payload.logo_url || null,
            pdf_path,
            pdf_url, // null if bucket is private
            verify_url: payload.verify_url,
            status: "valid",
            created_by: createdBy,
          })
          .select()
          .single();

        if (error) throw error;

        inserted.push(data);
      }

      // return JSON list so your UI can:
      // - show table
      // - “Download” per row (use pdf_url or sign a URL)
      // - “Download all” (call a separate endpoint)
      return res.json({
        count: inserted.length,
        items: inserted,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Generation failed" });
    }
  }
);

// GET /certificates  (list/paginate)
router.get(
  "/",
  requireAuth,
  allowRoles("admin", "registrar"),
  async (req, res) => {
    const { page = "1", pageSize = "20", q = "" } = req.query;
    const from = (Number(page) - 1) * Number(pageSize);
    const to = from + Number(pageSize) - 1;

    let query = supabase
      .from("certificates")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false });

    if (q) {
      // very simple filter on name or certificate_id
      query = query
        .ilike("full_name", `%${q}%`)
        .or(`certificate_id.ilike.%${q}%`);
    }

    const { data, error, count } = await query.range(from, to);
    if (error) return res.status(500).json({ error: error.message });

    res.json({
      page: Number(page),
      pageSize: Number(pageSize),
      count,
      items: data,
    });
  }
);

// GET /certificates/download/:id  -> stream a single PDF (or redirect)
router.get(
  "/download/:certificateId",
  requireAuth,
  allowRoles("admin", "registrar"),
  async (req, res) => {
    // If bucket is public and you stored pdf_url, you can 302 redirect:
    const { data, error } = await supabase
      .from("certificates")
      .select("pdf_url, pdf_path")
      .eq("certificate_id", req.params.certificateId)
      .single();

    if (error || !data) return res.status(404).json({ error: "Not found" });

    // If public URL exists, redirect
    if (data.pdf_url) return res.redirect(302, data.pdf_url);

    // If private bucket: sign a URL and redirect
    const { data: signed, error: signErr } = await supabase.storage
      .from("certificates")
      .createSignedUrl(data.pdf_path, 60); // 60s
    if (signErr) return res.status(500).json({ error: "Signing failed" });

    return res.redirect(302, signed.signedUrl);
  }
);

// GET /certificates/download-all  -> build a ZIP on the fly
import archiver from "archiver";
import { supabase } from "../lib/supabase.js";
import { allowRoles, requireAuth } from "./auth.js";

router.get(
  "/download-all",
  requireAuth,
  allowRoles("admin", "registrar"),
  async (req, res) => {
    // fetch recent N or all (careful with huge sets)
    const { data, error } = await supabase
      .from("certificates")
      .select("full_name, pdf_path, pdf_url")
      .order("created_at", { ascending: false })
      .limit(1000);
    if (error) return res.status(500).json({ error: error.message });

    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="certificates.zip"',
    });

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (e) => {
      throw e;
    });
    archive.pipe(res);

    // For each file, get a signed URL (if private) and fetch bytes, then append
    for (const row of data) {
      let fileUrl = row.pdf_url;
      if (!fileUrl) {
        const { data: signed } = await supabase.storage
          .from("certificates")
          .createSignedUrl(row.pdf_path, 60);
        fileUrl = signed.signedUrl;
      }

      const resp = await fetch(fileUrl);
      if (!resp.ok) continue;
      const buff = Buffer.from(await resp.arrayBuffer());
      const name = `${row.full_name.replace(/[\/\\:*?"<>|]/g, "-")}.pdf`;
      archive.append(buff, { name });
    }

    await archive.finalize();
  }
);

router.get(
  "/home",
  requireAuth,
  allowRoles("admin", "registrar"),
  async (req, res) => {
    try {
      const institution = req.user.institution; // 👈 from JWT
      const todayIso = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

      console.log("Fetching home summary for", req.user);

      // total (scoped)
      const { count: totalCount, error: cErr } = await supabase
        .from("certificates")
        .select("*", { count: "exact", head: true })
        .eq("institution_name", institution);
      if (cErr) throw cErr;

      // today (scoped)
      const { count: todayCount, error: tErr } = await supabase
        .from("certificates")
        .select("*", { count: "exact", head: true })
        .eq("institution_name", institution)
        .gte("created_at", `${todayIso}T00:00:00Z`);
      if (tErr) throw tErr;

      const { data: latest, error: lErr } = await supabase
        .from("certificates")
        .select("*")
        .eq("institution_name", institution)
        .order("created_at", { ascending: false });
      if (lErr) throw lErr;

      res.json({ totalCount, todayCount, latest });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message || "Failed to fetch summary" });
    }
  }
);

// PUBLIC: GET /verify/:certificateId
router.get("/verify/:certificateId", async (req, res) => {
  const code = (req.params.certificateId || "").trim();

  // tiny HTML escaper to keep content safe
  const esc = (s = "") =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  try {
    // pull cert + logo_url so we can show the school logo
    const { data: cert, error } = await supabase
      .from("certificates")
      .select(
        "full_name, program, certificate, cgpa, institution_name, created_at, pdf_url, pdf_path, certificate_id, status, logo_url"
      )
      .eq("certificate_id", code)
      .single();

    if (error || !cert) {
      return res.status(404).type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Certificate not found</title>
<style>
  body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;background:#f8fafc;color:#0f172a}
  .wrap{max-width:680px;margin:48px auto;padding:0 20px}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;box-shadow:0 10px 30px rgba(2,6,23,.06);padding:24px}
  .muted{color:#64748b}
  .code{font-family:ui-monospace,Menlo,Consolas,monospace;background:#0b1220;color:#e2e8f0;padding:6px 10px;border-radius:8px}
</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1 style="margin:0 0 8px">Certificate not found</h1>
      <p class="muted">We couldn't find a certificate with code:</p>
      <p><span class="code">${esc(code)}</span></p>
    </div>
  </div>
</body>
</html>`);
    }

    // choose a downloadable URL (public, or sign if private)
    let downloadUrl = cert.pdf_url || null;
    if (!downloadUrl && cert.pdf_path) {
      const { data: signed } = await supabase.storage
        .from("certificates")
        .createSignedUrl(cert.pdf_path, 60); // 60s
      downloadUrl = signed?.signedUrl || null;
    }

    const issued = new Date(cert.created_at);
    const issuedStr = issued.toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    return res.status(200).type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Certificate Verified · ${esc(cert.full_name)}</title>
  <style>
    :root { --brand:#2563eb; --ink:#0f172a; --muted:#64748b; --bg:#f8fafc; --card:#ffffff; --ring:#e5e7eb; --ok:#16a34a; }
    * { box-sizing:border-box; }
    body { margin:0; font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; color:var(--ink); background:
      radial-gradient(1000px 500px at 20% -10%, rgba(37,99,235,.08), transparent 60%),
      radial-gradient(800px 400px at 120% 0%, rgba(22,163,74,.08), transparent 60%),
      var(--bg);
    }
    .wrap { max-width: 860px; margin: 48px auto; padding: 0 20px; }
    .card { background:var(--card); border:1px solid var(--ring); border-radius:16px; box-shadow:0 10px 30px rgba(2,6,23,.06); overflow:hidden; }
    .bar { display:flex; align-items:center; gap:14px; padding:18px 22px; background:linear-gradient(90deg, rgba(37,99,235,.08), rgba(22,163,74,.08)); border-bottom:1px solid var(--ring); }
    .logo { width:44px; height:44px; border-radius:50%; overflow:hidden; border:1px solid var(--ring); background:#fff; flex:0 0 auto; }
    .brand { font-weight:700; letter-spacing:.2px; }
    .content { padding:26px 26px 18px; }
    .titleRow { display:flex; align-items:center; gap:10px; margin-bottom:6px; }
    .badge { display:inline-flex; align-items:center; gap:8px; padding:6px 10px; border-radius:999px; background:rgba(22,163,74,.12); color:#065f46; font-weight:600; font-size:.85rem; }
    .title { font-size:1.6rem; margin:0; }
    .sub { color:var(--muted); margin:6px 0 0; }
    .grid { display:grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap:16px; margin:22px 0; }
    @media (max-width:640px){ .grid{ grid-template-columns:1fr; } }
    .item { padding:14px 16px; background:#fafafa; border:1px solid var(--ring); border-radius:12px; }
    .label { display:block; font-size:.75rem; text-transform:uppercase; letter-spacing:.4px; color:var(--muted); margin-bottom:4px; }
    .value { font-weight:600; }
    .actions { display:flex; flex-wrap:wrap; gap:12px; margin-top:10px; }
    .btn { display:inline-flex; align-items:center; gap:8px; padding:10px 14px; border-radius:10px; text-decoration:none; font-weight:600; border:1px solid transparent; }
    .btn.primary { background:var(--brand); color:#fff; }
    .btn.primary:hover { filter:brightness(.95); }
    .btn.ghost { background:#f1f5f9; color:var(--ink); border-color:var(--ring); }
    .btn.ghost:hover { background:#e2e8f0; }
    .footer { padding:16px 22px 22px; color:var(--muted); font-size:.9rem; display:flex; justify-content:space-between; align-items:center; border-top:1px solid var(--ring); flex-wrap:wrap; gap:8px; }
    .code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background:#0b1220; color:#e2e8f0; padding:6px 10px; border-radius:8px; font-size:.9rem; }
    .toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%); background:#0b1220; color:#e2e8f0; padding:10px 14px; border-radius:10px; box-shadow:0 10px 30px rgba(2,6,23,.25); opacity:0; pointer-events:none; transition:opacity .25s ease; }
    .toast.show { opacity:1; }
    .okdot { width:8px; height:8px; background:var(--ok); border-radius:50%; box-shadow:0 0 0 3px rgba(22,163,74,.15); }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="bar">
        ${
          cert.logo_url
            ? `<div class="logo"><img src="${esc(
                cert.logo_url
              )}" alt="Logo" style="width:100%;height:100%;object-fit:cover"/></div>`
            : ""
        }
        <div>
          <div class="brand">${esc(cert.institution_name)}</div>
          <div style="font-size:.85rem;color:var(--muted);">Official certificate verification</div>
        </div>
      </div>

      <div class="content">
        <div class="titleRow">
          <span class="badge"><span class="okdot"></span> Verified</span>
          <h1 class="title">Certificate of ${esc(cert.certificate)}</h1>
        </div>
        <p class="sub">This certificate belongs to <strong>${esc(
          cert.full_name
        )}</strong>${cert.program ? ` — ${esc(cert.program)}` : ""}.</p>

        <div class="grid">
          <div class="item">
            <span class="label">Student</span>
            <span class="value">${esc(cert.full_name)}</span>
          </div>
          <div class="item">
            <span class="label">Program</span>
            <span class="value">${esc(cert.program || "—")}</span>
          </div>
          <div class="item">
            <span class="label">CGPA</span>
            <span class="value">${esc(cert.cgpa || "—")}</span>
          </div>
          <div class="item">
            <span class="label">Issued</span>
            <span class="value">${esc(issuedStr)}</span>
          </div>
        </div>

        <div class="actions">
          ${
            downloadUrl
              ? `<a class="btn primary" href="${downloadUrl}" target="_blank" rel="noopener">Download PDF</a>`
              : `<span class="btn ghost" aria-disabled="true">PDF unavailable</span>`
          }
          <button class="btn ghost" id="copyBtn" type="button">Copy Code</button>
          
        </div>
      </div>

      <div class="footer">
        <div>Certificate Code: <span class="code" id="codeEl">${esc(
          cert.certificate_id
        )}</span></div>
        <div>Status: <strong style="color:var(--ok)">Valid</strong></div>
      </div>
    </div>
  </div>

  <div class="toast" id="toast">Copied to clipboard</div>
  <script>
    (function () {
      var btn = document.getElementById('copyBtn');
      var codeEl = document.getElementById('codeEl');
      var toast = document.getElementById('toast');
      function showToast() { toast.classList.add('show'); setTimeout(function(){ toast.classList.remove('show'); }, 1200); }
      if (btn && codeEl) {
        btn.addEventListener('click', function() {
          var code = codeEl.textContent || '';
          navigator.clipboard.writeText(code).then(showToast).catch(showToast);
        });
      }
    })();
  </script>
</body>
</html>`);
  } catch (e) {
    console.error("Verify error:", e);
    return res.status(500).type("html").send("<h1>Server error</h1>");
  }
});

export default router;
