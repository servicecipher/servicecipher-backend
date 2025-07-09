// Always log version for debugging live deploys!
console.log('🔥🔥🔥 SERVICECIPHER DEPLOYED CODE VERSION: ', Date.now());

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const pdfParse = require('pdf-parse');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const puppeteer = require('puppeteer');
const allowedEmails = require('./allowed_emails.json');
require('dotenv').config();

const app = express();
const port = 3001;

// --- Only ONE CORS middleware, right after express() ---
app.use(cors({
  origin: [
    'https://servicecipher.com',
    'https://www.servicecipher.com',
    'https://servicecipher-frontend.vercel.app'
  ],
  credentials: true,
}));

app.use(express.json());
const upload = multer({ dest: 'uploads/' });

const sectionOrder = [
  'DATE',
  'SHOP_NAME',
  'REASON_FOR_VISIT',
  'REPAIR_SUMMARY',
  'MAJOR',
  'MODERATE',
  'MINOR',
  'COST_BREAKDOWN',
  'WHAT_DOES_THIS_ACTUALLY_MEAN?',
  'OTHER_NOTES',
  'RECOMMENDATIONS'
];

function prettySectionLabel(section) {
  if (section === 'WHAT_DOES_THIS_ACTUALLY_MEAN?') return 'What Does This Actually Mean?';
  return section.replace(/_/g, ' ').toLowerCase().replace(/(^|\s)\S/g, l => l.toUpperCase());
}

// Cleans ALL markdown formatting (**, *, __, etc.)
function cleanText(text) {
  if (!text) return '';
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/`(.*?)`/g, '$1');
}

// --- FUTURE PROOF SECTION FETCH ---
function getSection(sections, key, fallback = "Not provided") {
  if (
    sections[key] &&
    Array.isArray(sections[key]) &&
    sections[key][0] &&
    sections[key][0].toLowerCase() !== "none"
  ) {
    return cleanText(sections[key][0]);
  }
  return fallback;
}

function extractSections(text) {
  const result = {};
  let current = null;
  text.split('\n').forEach(line => {
    const trimmed = line.trim();
    const match = trimmed.match(/^\**\s*([A-Z _?']+)\s*\**\s*:?/i);
    if (match) {
      const sectionKey = match[1].replace(/ /g, '_').toUpperCase();
      if (sectionOrder.includes(sectionKey)) {
        current = sectionKey;
        result[current] = [];
        return;
      }
    }
    if (current && trimmed.length > 0) {
      result[current].push(cleanText(trimmed.replace(/^[-•]\s*/, "")));
    }
  });
  return result;
}

function buildSectionCard(label, content, styleClass = "") {
  if (!content || content.length === 0 || (content.length === 1 && content[0].toLowerCase() === 'none')) return '';
  let html = `<div class="section-card ${styleClass}">`;
  html += `<div class="section-heading ${styleClass}">${label}</div>`;
  html += `<div class="section-content">`;
  if (content.some(line => line.trim().startsWith('-') || line.trim().startsWith('•'))) {
    html += "<ul>";
    content.forEach(line => {
      html += `<li>${cleanText(line.replace(/^[-•]\s*/, ""))}</li>`;
    });
    html += "</ul>";
  } else if (label === "Cost Breakdown") {
    // Table/grid for cost breakdown
    html += '<div class="cost-table">';
    content.forEach(line => {
      // Try to split at the last ":" (for cases like "1. Something: $99.99")
      const idx = line.lastIndexOf(':');
      if (idx !== -1) {
        const item = cleanText(line.slice(0, idx+1));
        const price = cleanText(line.slice(idx+1)).trim();
        html += `<div class="cost-row"><div class="cost-item">${item}</div><div class="cost-price">${price}</div></div>`;
      } else {
        html += `<div class="cost-row"><div class="cost-item" style="grid-column: 1 / span 2;">${cleanText(line)}</div></div>`;
      }
    });
    html += '</div>';
  } else {
    html += content.map(line => {
      const match = line.match(/^(.+?):\s*(.*)$/);
      if (match) {
        if (!match[2]) {
          return `<div class="card-line"><span class="card-title">${cleanText(match[1])}:</span></div>`;
        }
        return `<div class="card-line"><span class="card-title">${cleanText(match[1])}:</span><br>${cleanText(match[2])}</div>`;
      }
      return `<div class="card-line">${cleanText(line)}</div>`;
    }).join('');
  }
  html += `</div></div>`;
  return html;
}

// --- BLUE CARD HELPER ---
function buildBlueCard(label, content) {
  // Accepts a string or array for content
  if (!content || (Array.isArray(content) && (!content[0] || content[0].toLowerCase() === "none")) || content === "Not provided") return '';
  const safeContent = Array.isArray(content) ? content.map(line => cleanText(line)).join("<br/>") : cleanText(content);
  return `
    <div class="section-card blue-card">
      <div class="section-heading blue">${label}</div>
      <div class="section-content">${safeContent}</div>
    </div>
  `;
}

// --- EMAIL AUTH MIDDLEWARE ---
// Expects frontend to send "x-user-email" header
function checkEmailAllowed(req, res, next) {
  const email = req.headers['x-user-email'];
  if (!email || !allowedEmails.includes(email)) {
    return res.status(403).json({ success: false, message: 'Email not allowed' });
  }
  next();
}

app.post('/api/upload', checkEmailAllowed, upload.single('pdf'), async (req, res) => {
  try {
    const fileBuffer = fs.readFileSync(req.file.path);
    const data = await pdfParse(fileBuffer);
    const invoiceText = data.text;

    // --- PROMPT (unchanged) ---
    const prompt = `
You are a professional, friendly auto service advisor. Your job is to help customers understand their auto repair invoice in plain, non-technical English—as if explaining to someone who knows nothing about cars. Your writing must always be detailed, helpful, and specific—even if the invoice itself is brief.

Given the invoice below, generate a full, customer-facing report with these exact sections (in this order):

DATE  
SHOP_NAME  
REASON_FOR_VISIT  
REPAIR_SUMMARY  
MAJOR  
MODERATE  
MINOR  
COST_BREAKDOWN  
WHAT_DOES_THIS_ACTUALLY_MEAN?  
OTHER_NOTES  
RECOMMENDATIONS

**Instructions for each section:**
- **DATE:** State the service date from the invoice, or use today's date if it's missing.
- **SHOP_NAME:** List the shop name, or leave blank if missing.
- **REASON_FOR_VISIT:** Always include 2–3 sentences in plain English about why the customer brought the vehicle in.  
  - If a reason is listed, summarize it clearly.  
  - If it's not listed, confidently infer the likely reason based on the repairs or services provided.  
  - **Never leave this section blank or write “None.”**

- **REPAIR_SUMMARY:** Always write 3–5 sentences summarizing every service or repair completed.  
  - Use simple language to explain what was done.  
  - If the invoice is brief or vague, use logical context to expand it into a helpful explanation.  
  - **Never skip this section or write “None.”**

- **MAJOR / MODERATE / MINOR:** For each, include 2–4 bullet points. Each bullet should explain:  
    - **What was fixed**  
    - **Why it mattered**  
    - **What could have happened if it wasn't fixed**  
    - If the section doesn’t apply, write “No major repairs” (or “None”).

- **COST_BREAKDOWN:** List every line item (parts, labor, fees, tax, etc.) as bullet points. Use numbers and include the total at the end.

- **WHAT_DOES_THIS_ACTUALLY_MEAN?:**  
  For every major part or service in the invoice (e.g. control arms, ball joints, alignment, brakes, ignition coils, battery, etc.), write a 1–3 sentence explanation of:  
    - What it does  
    - Why it matters  
    - What can happen if it fails  
  This section is educational — do not repeat why the car was brought in or what was done. Use a helpful tone, like this:
  - **Control Arms:** Control arms connect the wheels to the car’s frame and allow for smooth up-and-down movement. They are critical for stable steering and proper alignment. If they wear out or break, you may experience poor handling or even lose control of the vehicle.
  - **Ball Joints:** Ball joints act as pivots between the wheels and the suspension. They help the car turn and move smoothly over bumps. If a ball joint fails, it can cause steering problems or make the wheel detach.

- **OTHER_NOTES:** Add any warranty, reminders, or extra notes. If nothing is listed, write “No additional notes.”
- **RECOMMENDATIONS:** Offer 2–4 helpful, specific tips for future maintenance. Keep it friendly and non-salesy.

**General rules:**
- **Never skip a section.** Every section must be present — even if brief.
- **Do not summarize or repeat.** Each section must serve a unique purpose.
- **Be specific, helpful, and clear — like you're talking to a friend.**
- **Do not use code, markdown, or JSON.**
- **Use clear section titles and bullet points where needed.**

---  
INVOICE TO ANALYZE:  
--------------------  
${invoiceText}  
--------------------
`;

    // OpenAI call
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1400,
    });
    const summary = completion.choices[0].message.content;

    // Section extraction + debug log
    const sections = extractSections(summary);

    // Build blue cards for Reason For Visit and Repair Summary
    const reasonCard = buildBlueCard('Reason For Visit', sections['REASON_FOR_VISIT']);
    const summaryCard = buildBlueCard('Repair Summary', sections['REPAIR_SUMMARY']);

    // Build all other section cards
    let cardsHTML = "";
    sectionOrder.forEach(section => {
      if (
        section === 'SHOP_NAME' ||
        section === 'DATE' ||
        section === 'REASON_FOR_VISIT' ||
        section === 'REPAIR_SUMMARY'
      ) return;
      let label = prettySectionLabel(section);
      let cssClass = section.toLowerCase();
      cardsHTML += buildSectionCard(label, sections[section], cssClass);
    });

    // Load HTML template, inject content
    let htmlTemplate = fs.readFileSync(path.join(__dirname, 'templates/invoiceReport.html'), 'utf8');
    htmlTemplate = htmlTemplate
      .replace('{{SHOP_NAME}}', getSection(sections, 'SHOP_NAME'))
      .replace('{{DATE}}', getSection(sections, 'DATE'))
      .replace('{{REASON_FOR_VISIT_CARD}}', reasonCard)
      .replace('{{REPAIR_SUMMARY_CARD}}', summaryCard)
      .replace('{{SECTION_CARDS}}', cardsHTML);

    // Puppeteer: HTML to PDF (footer at the end, no gray space)
    const browser = await puppeteer.launch({ args: ['--no-sandbox'], headless: true });
    const pageObj = await browser.newPage();
    await pageObj.setContent(htmlTemplate, { waitUntil: 'networkidle0' });
    const pdfBuffer = await pageObj.pdf({
  format: 'A4',
  printBackground: true,
  margin: { top: '22px', bottom: '80px', left: '0', right: '0' }, // bottom must match footer height
  displayHeaderFooter: true,
  headerTemplate: `<span></span>`, // keeps header empty
  footerTemplate: `
  <div style="
    width: 100%;
    font-size: 14px;
    font-family: 'Segoe UI', Arial, sans-serif;
    color: #8a97b7;
    text-align: center;
    padding: 16px 0 10px 0;
    border-top: 1.6px solid #e6ebf3;
    letter-spacing: 0.01em;
  ">
    This report was generated by ServiceCipher™. Contact your repair shop with any questions.<br />
    &copy; 2025 ServiceCipher™.
  </div>
`,
});
    await browser.close();

    // Save PDF to /tmp (cross-platform, works on Railway)
    const timestamp = Date.now();
    const pdfPath = path.join('/tmp', `ServiceCipher_Report_${timestamp}.pdf`);
    fs.writeFileSync(pdfPath, pdfBuffer);
    fs.unlinkSync(req.file.path);

    res.json({ success: true, url: `/api/download/${path.basename(pdfPath)}` });
  } catch (err) {
    console.error('ERROR:', err);
    res.status(500).json({ success: false, message: 'Processing error.' });
  }
});

app.get('/api/download/:filename', (req, res) => {
  const file = path.join('/tmp', req.params.filename);  // read from /tmp!
  res.download(file);
});

app.listen(port, () => console.log(`Server running on port ${port}`));
