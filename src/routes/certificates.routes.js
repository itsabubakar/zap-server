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
        process.env.PUBLIC_BASE_URL || "https://zap-front.vercel.app";
      const createdBy = req.user?.id || null;

      const inserted = [];

      for (const row of rows) {
        const certificateId = uuidv4();
        const verifyUrl = `${publicBase}/verify/${certificateId}`;

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

export default router;
